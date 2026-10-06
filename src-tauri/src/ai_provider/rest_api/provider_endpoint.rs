//! One resolution of a REST provider for the settings-page probes.
//!
//! The key test, the model list and the model check each need the same four
//! facts about a provider: which id it is, which base URL applies (a vendor
//! default, a user override, or a mandatory user value), whether a key is
//! required, and which header carries it. `ProviderEndpoint::resolve` decides
//! them once; the three commands in `rest_api.rs` then ask it for the request
//! they need, so a new provider is added in one place instead of three.
//!
//! Nothing here performs I/O: probes are plain values and `request` returns an
//! unsent builder, which is what makes the request shapes testable.

use reqwest::Method;

use crate::ai_provider::endpoint::resolve_endpoint;

const OPENAI_DEFAULT_BASE: &str = "https://api.openai.com";
const ANTHROPIC_DEFAULT_BASE: &str = "https://api.anthropic.com";
const OLLAMA_DEFAULT_BASE: &str = "http://localhost:11434";
/// Google's host is fixed: a user-supplied endpoint is ignored for it.
const GOOGLE_BASE: &str = "https://generativelanguage.googleapis.com";

const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Model named by the Anthropic key test, which has no listing endpoint to
/// call and so sends a one-token message instead.
const ANTHROPIC_KEY_TEST_MODEL: &str = "claude-sonnet-4-5-20250929";

/// The REST providers the settings page can probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RestProvider {
    OpenAi,
    OpenAiCompatible,
    GoogleAi,
    OllamaApi,
    Anthropic,
}

impl RestProvider {
    /// Map the wire id the frontend sends to a provider.
    pub(super) fn parse(id: &str) -> Result<Self, String> {
        match id {
            "openai" => Ok(Self::OpenAi),
            "openai-compatible" => Ok(Self::OpenAiCompatible),
            "google-ai" => Ok(Self::GoogleAi),
            "ollama-api" => Ok(Self::OllamaApi),
            "anthropic" => Ok(Self::Anthropic),
            other => Err(format!("Unknown provider: {other}")),
        }
    }
}

/// How a provider's credential travels. The key lives only here, so it can
/// reach a request header and nowhere else.
enum Credential {
    /// Local Ollama: unauthenticated.
    None,
    /// `Authorization: Bearer <key>`.
    Bearer(String),
    /// `x-goog-api-key: <key>`.
    GoogleKey(String),
    /// `x-api-key: <key>` plus the pinned `anthropic-version`.
    AnthropicKey(String),
}

/// A request to send, described without a client: method, URL, optional JSON
/// body. Credentials are added by [`ProviderEndpoint::request`].
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Probe {
    pub(super) method: Method,
    pub(super) url: String,
    pub(super) body: Option<serde_json::Value>,
}

impl Probe {
    fn get(url: String) -> Self {
        Self {
            method: Method::GET,
            url,
            body: None,
        }
    }

    fn post(url: String, body: serde_json::Value) -> Self {
        Self {
            method: Method::POST,
            url,
            body: Some(body),
        }
    }
}

/// A provider with its base URL and credential settled.
pub(super) struct ProviderEndpoint {
    provider: RestProvider,
    base: String,
    credential: Credential,
}

/// Redacted on purpose: a derived `Debug` would print the API key into any
/// log line or assertion message that formats this value.
impl std::fmt::Debug for ProviderEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderEndpoint")
            .field("provider", &self.provider)
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

fn require_key(api_key: Option<String>) -> Result<String, String> {
    api_key
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "API key is required".to_string())
}

/// Resolve a base URL that MUST be user-supplied (no sensible default host).
///
/// The `openai-compatible` provider is generic — there is no vendor default to
/// fall back to — so an empty endpoint is a hard error rather than a silent
/// request to some placeholder host.
fn require_endpoint(endpoint: Option<String>) -> Result<String, String> {
    let base = resolve_endpoint(endpoint, "");
    if base.is_empty() {
        return Err("Endpoint (base URL) is required".to_string());
    }
    Ok(base)
}

/// The smallest chat request that names `model`: one token of output.
fn one_token_chat(model: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "Hi"}]
    })
}

impl ProviderEndpoint {
    /// Settle the base URL and credential for `provider`.
    ///
    /// A missing key is reported before a missing endpoint, so the user fixes
    /// the field they see first. Ollama takes no key; a key passed for it is
    /// dropped rather than sent to a local server that never asked for one.
    pub(super) fn resolve(
        provider: RestProvider,
        api_key: Option<String>,
        endpoint: Option<String>,
    ) -> Result<Self, String> {
        let (base, credential) = match provider {
            RestProvider::OpenAi => {
                let key = require_key(api_key)?;
                (
                    resolve_endpoint(endpoint, OPENAI_DEFAULT_BASE),
                    Credential::Bearer(key),
                )
            }
            RestProvider::OpenAiCompatible => {
                let key = require_key(api_key)?;
                (require_endpoint(endpoint)?, Credential::Bearer(key))
            }
            RestProvider::GoogleAi => {
                let key = require_key(api_key)?;
                (GOOGLE_BASE.to_string(), Credential::GoogleKey(key))
            }
            RestProvider::OllamaApi => (
                resolve_endpoint(endpoint, OLLAMA_DEFAULT_BASE),
                Credential::None,
            ),
            RestProvider::Anthropic => {
                let key = require_key(api_key)?;
                (
                    resolve_endpoint(endpoint, ANTHROPIC_DEFAULT_BASE),
                    Credential::AnthropicKey(key),
                )
            }
        };
        Ok(Self {
            provider,
            base,
            credential,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// The model listing, for the providers that have one.
    pub(super) fn models_probe(&self) -> Option<Probe> {
        let path = match self.provider {
            RestProvider::OpenAi | RestProvider::OpenAiCompatible => "/v1/models",
            RestProvider::GoogleAi => "/v1beta/models",
            RestProvider::OllamaApi => "/api/tags",
            RestProvider::Anthropic => return None,
        };
        Some(Probe::get(self.url(path)))
    }

    /// The cheapest request that proves the key (or, for Ollama, the server)
    /// works: the model listing where there is one, otherwise a one-token
    /// message.
    pub(super) fn key_probe(&self) -> Probe {
        self.models_probe()
            .unwrap_or_else(|| self.model_probe(ANTHROPIC_KEY_TEST_MODEL))
    }

    /// The smallest request that fails when `model` is not usable.
    pub(super) fn model_probe(&self, model: &str) -> Probe {
        match self.provider {
            RestProvider::OpenAi | RestProvider::OpenAiCompatible => {
                Probe::post(self.url("/v1/chat/completions"), one_token_chat(model))
            }
            RestProvider::Anthropic => Probe::post(self.url("/v1/messages"), one_token_chat(model)),
            RestProvider::GoogleAi => {
                let id = model.strip_prefix("models/").unwrap_or(model);
                Probe::post(
                    self.url(&format!("/v1beta/models/{id}:generateContent")),
                    serde_json::json!({ "contents": [{"parts": [{"text": "Hi"}]}] }),
                )
            }
            RestProvider::OllamaApi => {
                Probe::post(self.url("/api/show"), serde_json::json!({ "name": model }))
            }
        }
    }

    /// Turn a probe into an unsent request carrying this provider's credential.
    pub(super) fn request(
        &self,
        client: &reqwest::Client,
        probe: Probe,
    ) -> reqwest::RequestBuilder {
        let req = client.request(probe.method, probe.url);
        let req = match &self.credential {
            Credential::None => req,
            Credential::Bearer(key) => req.header("Authorization", format!("Bearer {key}")),
            Credential::GoogleKey(key) => req.header("x-goog-api-key", key),
            Credential::AnthropicKey(key) => req
                .header("x-api-key", key)
                .header("anthropic-version", ANTHROPIC_VERSION),
        };
        match probe.body {
            Some(body) => req.json(&body),
            None => req,
        }
    }
}

#[cfg(test)]
#[path = "provider_endpoint.test.rs"]
mod tests;
