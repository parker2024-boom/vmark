// WI-RA24.8 — which `.lock()` calls the lock-policy gate sets aside as
// `std::fs::File::lock`: an `io::Result<()>` with no poison to drop, which a
// text scan cannot tell from a mutex's by the call alone. Decided mechanically
// from the blanked code the gate scans, by either of two proofs:
//
//   - TYPE: the call's Ok payload is destructured as `()` — `Ok(())` as the
//     pattern of a `let` whose scrutinee is the call itself, or a
//     `.map(|()| …)` / `.and_then(|()| …)` closure on it. A lock guard is never
//     `()`, so the call cannot be a mutex's or an RwLock's.
//   - RECEIVER: the identifier `.lock()` is called on is bound, nearest visible
//     binding first, as `let [mut] NAME[: File] = <a File constructor>;`, as the
//     lone parameter of a closure handed to `.and_then(` / `.map(` /
//     `.inspect(` straight on an `.open(..)` call, or as a `NAME: &File`
//     parameter. Every other binding of the name (`let`, `if let`, `for`, a
//     match arm, a closure or fn parameter) is not a file, so a shadowing mutex
//     wins. A field (`a.b.lock()`) has no binding to read: its type is unknown,
//     and it stays a mutex.
//
// Not a Rust parser. Scope is read from text order: a binding is visible from
// the end of its `let` statement (the opening brace of an `if let`), from its
// parameter or match arm onward, and a file closure parameter only inside the
// call it is handed to. Every approximation errs toward reporting the site.

use regex::Regex;

/// Whether the lock call whose `.` sits at `call` in blanked `code` is a
/// file lock (see the header for the two proofs).
pub(super) fn is_file_lock(code: &str, call: usize) -> bool {
    let lock = Regex::new(r"^\.\s*lock\s*\(\s*\)").expect("lock call");
    let Some(found) = lock.find(&code[call..]) else {
        return false; // `.read()` / `.write()`: a `File` has no zero-argument one
    };
    unit_payload(code, call, call + found.end())
        || receiver(code, call)
            .is_some_and(|name| nearest_binding_is_file(code, &Name::new(name), call))
}

/// `RECV.lock().map(|()| …)`, or `let Ok(()) = RECV.lock()` with nothing
/// chained after the call (`end` is just past its `)`).
fn unit_payload(code: &str, call: usize, end: usize) -> bool {
    let mapped =
        Regex::new(r"^\s*\.\s*(?:map|and_then)\s*\(\s*\|\s*\(\s*\)\s*\|").expect("unit closure");
    let pattern =
        Regex::new(r"\blet\s+Ok\s*\(\s*\(\s*\)\s*\)\s*=\s*[^;{]*$").expect("unit pattern");
    let scrutinee_ends = Regex::new(r"^\s*(?:\{|else\b|;)").expect("scrutinee end");
    mapped.is_match(&code[end..])
        || (pattern.is_match(&code[..call]) && scrutinee_ends.is_match(&code[end..]))
}

/// The plain identifier the call is made on; `None` for a field, a path, or
/// any other expression, whose type the scan cannot see.
fn receiver(code: &str, call: usize) -> Option<&str> {
    let head = code[..call].trim_end();
    let ident = |b: &u8| b.is_ascii_alphanumeric() || *b == b'_';
    let start = head.len() - head.bytes().rev().take_while(ident).count();
    let name = &head[start..];
    let before = head[..start].trim_end();
    let plain = !name.is_empty()
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name != "self"
        && !before.ends_with('.')
        && !before.ends_with(':');
    plain.then_some(name)
}

/// A receiver's name, with a matcher for it as a whole word.
struct Name<'a> {
    text: &'a str,
    word: Regex,
}

impl<'a> Name<'a> {
    fn new(text: &'a str) -> Self {
        let word = Regex::new(&format!(r"\b{}\b", regex::escape(text))).expect("name regex");
        Name { text, word }
    }

    fn mentioned_in(&self, text: &str) -> bool {
        self.word.is_match(text)
    }
}

/// One binding of a name: visible over `from..until`, and whether it is a file.
struct Binding {
    from: usize,
    until: usize,
    file: bool,
}

impl Binding {
    /// Visible from `from` to the end of the scanned code.
    fn open_ended(from: usize, file: bool) -> Self {
        let until = usize::MAX;
        Binding { from, until, file }
    }
}

fn nearest_binding_is_file(code: &str, name: &Name, call: usize) -> bool {
    let mut all = let_bindings(code, name);
    all.extend(parameter_bindings(code, name));
    all.extend(pattern_bindings(code, name));
    all.into_iter()
        .filter(|binding| binding.from <= call && call < binding.until)
        .max_by_key(|binding| binding.from)
        .is_some_and(|binding| binding.file)
}

/// `let PAT = INIT;`, `if let` and `while let`. A file only as
/// `let [mut] NAME[: File] = INIT` where INIT is a `File` constructor.
fn let_bindings(code: &str, name: &Name) -> Vec<Binding> {
    let statement =
        Regex::new(r"(?P<cond>\b(?:if|while)\s+)?\blet\s+(?P<pat>[^=;]*?)\s*=").expect("let");
    statement
        .captures_iter(code)
        .filter(|found| name.mentioned_in(&found["pat"]))
        .map(|found| {
            let init = found.get(0).expect("whole match").end();
            let opens_block = found.name("cond").is_some();
            let ends = if opens_block { '{' } else { ';' };
            let from = code[init..].find(ends).map_or(code.len(), |n| init + n);
            let file = plain(&found["pat"]).is_some_and(|(bound, ty)| {
                bound == name.text
                    && (ty.is_some_and(is_file_type) || constructs_file(&code[init..from]))
            });
            Binding::open_ended(from, file)
        })
        .collect()
}

/// Closure and fn parameters. A file as `NAME: [&[mut]] File`, or as the lone
/// parameter of a closure chained straight on an `.open(..)` call — visible
/// only inside that call.
fn parameter_bindings(code: &str, name: &Name) -> Vec<Binding> {
    let closure = Regex::new(r"(?P<open>[(,=]|\bmove)\s*\|(?P<list>[^|;{}=]*)\|").expect("closure");
    let function = Regex::new(r"\bfn\s+\w+[^(]*\(").expect("fn");
    let mut found = Vec::new();
    for params in closure.captures_iter(code) {
        let (open, list) = (&params["open"], params.name("list").expect("list"));
        let at = params.get(0).expect("whole match").start();
        let on_open = open == "("
            && plain(list.as_str()).is_some_and(|(bound, ty)| bound == name.text && ty.is_none())
            && chained_on_open(code, at);
        let until = on_open.then(|| close_of(code, at)).flatten();
        let until = until.unwrap_or(usize::MAX);
        found.extend(parameter(list.as_str(), name).map(|typed_file| Binding {
            from: list.start(),
            until,
            file: typed_file || on_open,
        }));
    }
    for signature in function.find_iter(code) {
        let open = signature.end() - 1;
        let close = close_of(code, open).unwrap_or(code.len());
        found.extend(
            parameter(&code[signature.end()..close], name)
                .map(|file| Binding::open_ended(open, file)),
        );
    }
    found
}

/// `Some(is a typed File)` when the parameter list `list` binds `name`.
fn parameter(list: &str, name: &Name) -> Option<bool> {
    let binder = list.split(',').find(|entry| name.mentioned_in(entry))?;
    let typed =
        |(bound, ty): (&str, Option<&str>)| bound == name.text && ty.is_some_and(is_file_type);
    Some(plain(binder).is_some_and(typed))
}

/// `for PAT in` and match-arm `PAT =>` bindings: never a file. An arm's
/// pattern is read as everything on its line before `=>` (back to the
/// previous `=>`), so a mention there counts as a binding.
fn pattern_bindings(code: &str, name: &Name) -> Vec<Binding> {
    let for_loop = Regex::new(r"\bfor\s+(?P<pat>[^;{}]*?)\s+in\b").expect("for");
    let mut found: Vec<Binding> = for_loop
        .captures_iter(code)
        .filter(|binding| name.mentioned_in(&binding["pat"]))
        .map(|binding| Binding::open_ended(binding.get(0).expect("whole match").end(), false))
        .collect();
    let mut previous_arm = 0;
    for (arrow, _) in code.match_indices("=>") {
        let line = code[..arrow].rfind('\n').map_or(0, |n| n + 1);
        if name.mentioned_in(&code[line.max(previous_arm)..arrow]) {
            found.push(Binding::open_ended(arrow, false));
        }
        previous_arm = arrow + 2;
    }
    found
}

/// Whether the `(` at `paren` opens `.and_then(` / `.map(` / `.inspect(`
/// called directly on `.open(..)` or on a `File` constructor.
fn chained_on_open(code: &str, paren: usize) -> bool {
    let adapter = Regex::new(r"\.\s*(?:and_then|map|inspect)\s*$").expect("adapter");
    let opener =
        Regex::new(r"(?:\.\s*open|\bFile\s*::\s*(?:open|create|create_new))\s*$").expect("opener");
    let Some(dot) = adapter.find(&code[..paren]).map(|m| m.start()) else {
        return false;
    };
    let receiver = code[..dot].trim_end();
    receiver.ends_with(')')
        && open_of(code, receiver.len() - 1).is_some_and(|open| opener.is_match(&code[..open]))
}

/// An initializer that evaluates to a `File` and nothing else: a `File`
/// constructor, or an options builder ending in `.open(..)`, followed only by
/// error handling. `File::open(p).map(Mutex::new)` is not a file.
fn constructs_file(init: &str) -> bool {
    let Some(chain) = call_chain(init) else {
        return false;
    };
    let Some((head, rest)) = chain.split_first() else {
        return false;
    };
    let after_open = match head.trim_start_matches("std::").trim_start_matches("fs::") {
        "File::open" | "File::create" | "File::create_new" => rest,
        "File::options" | "OpenOptions::new" => match rest.iter().position(|m| m == "open") {
            Some(open) => &rest[open + 1..],
            None => return false,
        },
        _ => return false,
    };
    let error_handling = ["?", "map_err", "expect", "unwrap"];
    after_open
        .iter()
        .all(|m| error_handling.contains(&m.as_str()))
}

/// `a::b(..).c(..)?` as `["a::b", "c", "?"]`; `None` for any other expression.
fn call_chain(expr: &str) -> Option<Vec<String>> {
    let head = Regex::new(r"^\s*(\w+(?:\s*::\s*\w+)*)\s*\(").expect("chain head");
    let link = Regex::new(r"^\s*(?:\?|\.\s*(\w+)\s*\()").expect("chain link");
    let found = head.captures(expr)?;
    let mut chain = vec![found[1].split_whitespace().collect::<String>()];
    let mut at = close_of(expr, found.get(0)?.end() - 1)? + 1;
    while let Some(next) = link.captures(&expr[at..]) {
        let end = at + next.get(0)?.end();
        match next.get(1) {
            Some(method) => {
                chain.push(method.as_str().to_owned());
                at = close_of(expr, end - 1)? + 1;
            }
            None => {
                chain.push("?".to_owned());
                at = end;
            }
        }
    }
    expr[at..].trim().is_empty().then_some(chain)
}

/// `[mut] NAME[: TYPE]`, as `(NAME, TYPE)`.
fn plain(binder: &str) -> Option<(&str, Option<&str>)> {
    let shape = Regex::new(r"^\s*(?:mut\s+)?(\w+)\s*(?::\s*(.+?))?\s*$").expect("plain binder");
    let found = shape.captures(binder)?;
    Some((found.get(1)?.as_str(), found.get(2).map(|ty| ty.as_str())))
}

/// `File`, `fs::File` or `std::fs::File`, owned or behind `&` / `&mut`.
fn is_file_type(ty: &str) -> bool {
    Regex::new(r"^(?:&\s*(?:'\w+\s+)?(?:mut\s+)?)?(?:(?:std\s*::\s*)?fs\s*::\s*)?File$")
        .expect("file type")
        .is_match(ty.trim())
}

/// The `)` that closes the `(` at `open`.
fn close_of(code: &str, open: usize) -> Option<usize> {
    balance(code.as_bytes().iter().enumerate().skip(open), b'(', b')')
}

/// The `(` that the `)` at `close` closes.
fn open_of(code: &str, close: usize) -> Option<usize> {
    balance(
        code.as_bytes()[..=close].iter().enumerate().rev(),
        b')',
        b'(',
    )
}

/// Walk `bytes` from a `nest` byte to the `unnest` byte that balances it.
fn balance<'a>(
    bytes: impl Iterator<Item = (usize, &'a u8)>,
    nest: u8,
    unnest: u8,
) -> Option<usize> {
    let mut depth = 0usize;
    for (at, &byte) in bytes {
        if byte == nest {
            depth += 1;
        } else if byte == unnest {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(at);
            }
        }
    }
    None
}
