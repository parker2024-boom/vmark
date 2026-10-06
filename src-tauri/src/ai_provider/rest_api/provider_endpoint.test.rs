//! WI-RA12A.3 — one resolution of a REST provider's base URL, credentials and
//! probe requests, shared by the key test, the model list and the model check.
//!
//! Everything is read off values and UNSENT `reqwest::Request`s: no server.

use super::{ProviderEndpoint, RestProvider};
use reqwest::Method;

const KEY: &str = "sk-LEAK-CANARY";

fn key() -> Option<String> {
    Some(KEY.to_string())
}

fn resolve(id: &str, api_key: Option<String>, endpoint: Option<&str>) -> ProviderEndpoint {
    try_resolve(id, api_key, endpoint).expect("resolves")
}

fn try_resolve(
    id: &str,
    api_key: Option<String>,
    endpoint: Option<&str>,
) -> Result<ProviderEndpoint, String> {
    ProviderEndpoint::resolve(
        RestProvider::parse(id)?,
        api_key,
        endpoint.map(str::to_string),
    )
}

fn header<'a>(req: &'a reqwest::Request, name: &str) -> Option<&'a str> {
    req.headers().get(name).map(|v| v.to_str().unwrap())
}

const ALL: [&str; 5] = [
    "openai",
    "openai-compatible",
    "google-ai",
    "ollama-api",
    "anthropic",
];

#[test]
fn parse_accepts_every_rest_provider_id_and_nothing_else() {
    assert_eq!(RestProvider::parse("openai"), Ok(RestProvider::OpenAi));
    assert_eq!(
        RestProvider::parse("openai-compatible"),
        Ok(RestProvider::OpenAiCompatible)
    );
    assert_eq!(RestProvider::parse("google-ai"), Ok(RestProvider::GoogleAi));
    assert_eq!(
        RestProvider::parse("ollama-api"),
        Ok(RestProvider::OllamaApi)
    );
    assert_eq!(
        RestProvider::parse("anthropic"),
        Ok(RestProvider::Anthropic)
    );
    for bad in ["", "OpenAI", "openai ", "ollama", "克劳德"] {
        assert_eq!(
            RestProvider::parse(bad),
            Err(format!("Unknown provider: {bad}"))
        );
    }
}

#[test]
fn default_hosts_apply_when_the_endpoint_is_absent_or_empty() {
    for endpoint in [None, Some("")] {
        assert_eq!(
            resolve("openai", key(), endpoint).key_probe().url,
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            resolve("anthropic", key(), endpoint).key_probe().url,
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            resolve("ollama-api", None, endpoint).key_probe().url,
            "http://localhost:11434/api/tags"
        );
    }
}

#[test]
fn a_custom_endpoint_is_normalized_so_v1_is_never_doubled() {
    for base in [
        "https://h.example/v1",
        "https://h.example/v1/",
        "https://h.example/",
    ] {
        assert_eq!(
            resolve("openai", key(), Some(base)).key_probe().url,
            "https://h.example/v1/models"
        );
        assert_eq!(
            resolve("openai-compatible", key(), Some(base))
                .model_probe("m")
                .url,
            "https://h.example/v1/chat/completions"
        );
        assert_eq!(
            resolve("anthropic", key(), Some(base)).model_probe("m").url,
            "https://h.example/v1/messages"
        );
    }
    assert_eq!(
        resolve("ollama-api", None, Some("http://ollama.example:11434/"))
            .model_probe("m")
            .url,
        "http://ollama.example:11434/api/show"
    );
}

#[test]
fn google_ignores_a_custom_endpoint() {
    let ep = resolve("google-ai", key(), Some("https://elsewhere.example"));
    assert_eq!(
        ep.key_probe().url,
        "https://generativelanguage.googleapis.com/v1beta/models"
    );
}

#[test]
fn a_missing_or_empty_key_is_refused_for_every_keyed_provider() {
    for id in ["openai", "openai-compatible", "google-ai", "anthropic"] {
        for k in [None, Some(String::new())] {
            assert_eq!(
                try_resolve(id, k, Some("https://h.example")).unwrap_err(),
                "API key is required",
                "{id}"
            );
        }
    }
}

#[test]
fn ollama_needs_no_key_and_sends_none_even_when_given_one() {
    for k in [None, key()] {
        let ep = resolve("ollama-api", k, None);
        let req = ep
            .request(&reqwest::Client::new(), ep.key_probe())
            .build()
            .unwrap();
        assert!(header(&req, "authorization").is_none());
        assert!(header(&req, "x-api-key").is_none());
        assert!(header(&req, "x-goog-api-key").is_none());
    }
}

#[test]
fn openai_compatible_requires_an_endpoint_and_reports_the_key_first() {
    for endpoint in [None, Some("")] {
        assert_eq!(
            try_resolve("openai-compatible", key(), endpoint).unwrap_err(),
            "Endpoint (base URL) is required"
        );
        assert_eq!(
            try_resolve("openai-compatible", None, endpoint).unwrap_err(),
            "API key is required"
        );
    }
}

#[test]
fn key_probe_is_the_cheapest_request_each_provider_offers() {
    let cases = [
        ("openai", Method::GET, "https://h.example/v1/models"),
        (
            "openai-compatible",
            Method::GET,
            "https://h.example/v1/models",
        ),
        (
            "google-ai",
            Method::GET,
            "https://generativelanguage.googleapis.com/v1beta/models",
        ),
        ("ollama-api", Method::GET, "https://h.example/api/tags"),
        ("anthropic", Method::POST, "https://h.example/v1/messages"),
    ];
    for (id, method, url) in cases {
        let probe = resolve(id, key(), Some("https://h.example")).key_probe();
        assert_eq!(probe.method, method, "{id}");
        assert_eq!(probe.url, url, "{id}");
        assert_eq!(probe.body.is_some(), id == "anthropic", "{id}");
    }
    // Anthropic has no listing endpoint, so its key test is a one-token message.
    let body = resolve("anthropic", key(), None).key_probe().body.unwrap();
    assert_eq!(body["max_tokens"], 1);
    assert_eq!(body["messages"][0]["role"], "user");
    assert!(body["model"].as_str().unwrap().starts_with("claude-"));
}

#[test]
fn models_probe_is_a_get_of_the_listing_and_absent_for_anthropic() {
    let cases = [
        ("openai", "https://h.example/v1/models"),
        ("openai-compatible", "https://h.example/v1/models"),
        (
            "google-ai",
            "https://generativelanguage.googleapis.com/v1beta/models",
        ),
        ("ollama-api", "https://h.example/api/tags"),
    ];
    for (id, url) in cases {
        let probe = resolve(id, key(), Some("https://h.example"))
            .models_probe()
            .unwrap_or_else(|| panic!("{id} lists models"));
        assert_eq!(probe.method, Method::GET, "{id}");
        assert_eq!(probe.url, url, "{id}");
        assert!(probe.body.is_none(), "{id}");
    }
    assert!(resolve("anthropic", key(), None).models_probe().is_none());
}

#[test]
fn model_probe_posts_the_smallest_request_that_names_the_model() {
    let chat = serde_json::json!({
        "model": "模型-x",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "Hi"}]
    });
    for (id, url) in [
        ("openai", "https://h.example/v1/chat/completions"),
        ("openai-compatible", "https://h.example/v1/chat/completions"),
        ("anthropic", "https://h.example/v1/messages"),
    ] {
        let probe = resolve(id, key(), Some("https://h.example")).model_probe("模型-x");
        assert_eq!(probe.method, Method::POST, "{id}");
        assert_eq!(probe.url, url, "{id}");
        assert_eq!(probe.body, Some(chat.clone()), "{id}");
    }

    let ollama = resolve("ollama-api", None, None).model_probe("llama3:8b");
    assert_eq!(ollama.method, Method::POST);
    assert_eq!(ollama.url, "http://localhost:11434/api/show");
    assert_eq!(
        ollama.body,
        Some(serde_json::json!({ "name": "llama3:8b" }))
    );
}

#[test]
fn google_model_probe_strips_one_models_prefix() {
    let ep = resolve("google-ai", key(), None);
    for model in ["gemini-2.0-flash", "models/gemini-2.0-flash"] {
        let probe = ep.model_probe(model);
        assert_eq!(
            probe.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
        );
        assert_eq!(
            probe.body,
            Some(serde_json::json!({ "contents": [{"parts": [{"text": "Hi"}]}] }))
        );
    }
    // An empty model id is passed through for the provider to reject.
    assert_eq!(
        ep.model_probe("").url,
        "https://generativelanguage.googleapis.com/v1beta/models/:generateContent"
    );
}

#[test]
fn request_carries_each_providers_credential_header_and_only_that_one() {
    let client = reqwest::Client::new();
    let build = |id: &str| {
        let ep = resolve(id, key(), Some("https://h.example"));
        ep.request(&client, ep.model_probe("m")).build().unwrap()
    };

    for id in ["openai", "openai-compatible"] {
        let req = build(id);
        assert_eq!(header(&req, "authorization"), Some("Bearer sk-LEAK-CANARY"));
        assert!(header(&req, "x-api-key").is_none());
        assert!(header(&req, "x-goog-api-key").is_none());
    }

    let google = build("google-ai");
    assert_eq!(header(&google, "x-goog-api-key"), Some(KEY));
    assert!(header(&google, "authorization").is_none());

    let anthropic = build("anthropic");
    assert_eq!(header(&anthropic, "x-api-key"), Some(KEY));
    assert_eq!(header(&anthropic, "anthropic-version"), Some("2023-06-01"));
    assert!(header(&anthropic, "authorization").is_none());
}

#[test]
fn request_sends_json_bodies_as_json_and_gets_without_a_body() {
    let client = reqwest::Client::new();
    for id in ALL {
        let ep = resolve(id, key(), Some("https://h.example"));
        let post = ep.request(&client, ep.model_probe("m")).build().unwrap();
        assert_eq!(post.method(), Method::POST, "{id}");
        assert_eq!(
            header(&post, "content-type"),
            Some("application/json"),
            "{id}"
        );
        let sent: serde_json::Value =
            serde_json::from_slice(post.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(Some(sent), ep.model_probe("m").body, "{id}");

        if let Some(list) = ep.models_probe() {
            let get = ep.request(&client, list).build().unwrap();
            assert_eq!(get.method(), Method::GET, "{id}");
            assert!(get.body().is_none(), "{id}");
        }
    }
}

#[test]
fn the_key_never_appears_in_a_url_or_in_debug_output() {
    for id in ALL {
        let ep = resolve(id, key(), Some("https://h.example"));
        let mut probes = vec![ep.key_probe(), ep.model_probe("m")];
        probes.extend(ep.models_probe());
        for probe in probes {
            assert!(!probe.url.contains(KEY), "{id}: {}", probe.url);
        }
        assert!(!format!("{ep:?}").contains(KEY), "{id}");
    }
}
