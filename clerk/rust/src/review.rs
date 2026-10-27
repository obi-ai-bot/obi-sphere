//! The review profile's tally (`spec/council/review.md`, section 6): from a panel's envelopes in the chain to
//! the clerk's count input. It reads only what stays readable when the words are sealed (types, members,
//! outcomes, commit ids, finding ids and severities, acceptance kinds and results), so anyone holding the
//! chain can count again without a key. The known-answer vectors in `clerk/vectors/review.json` pin it down,
//! and the TypeScript in `clerk/ts` gives the same answers.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use crate::MAX_INT;

/// Why a tally input can't be used. The code is what the vectors name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TallyError {
    BadInput,
    BadPanel,
    TwoRequests,
}

impl TallyError {
    pub fn code(self) -> &'static str {
        match self {
            TallyError::BadInput => "bad_input",
            TallyError::BadPanel => "bad_panel",
            TallyError::TwoRequests => "two_requests",
        }
    }
}

impl std::fmt::Display for TallyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for TallyError {}

use TallyError::*;

fn id(v: Option<&Value>) -> Option<&str> {
    v?.as_str().filter(|s| !s.is_empty())
}

fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64)
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Repositories compare ignoring ASCII case (protocol.md section 5.9).
fn same_repo(a: Option<&Value>, b: &str) -> bool {
    a.and_then(Value::as_str)
        .is_some_and(|a| a.eq_ignore_ascii_case(b))
}

/// The clerk's count input for a review panel, from its envelopes in chain order (review.md section 6).
pub fn tally(input: &Value) -> Result<Value, TallyError> {
    let o = input.as_object().ok_or(BadInput)?;
    let keys = [
        "convener",
        "subject",
        "rule",
        "quorum",
        "veto",
        "seats",
        "envelopes",
    ];
    if !keys.iter().all(|k| o.contains_key(*k))
        || !o
            .keys()
            .all(|k| keys.contains(&k.as_str()) || k == "verifier")
    {
        return Err(BadInput);
    }
    let subject = o["subject"]
        .as_object()
        .filter(|s| s.len() == 2)
        .ok_or(BadInput)?;
    let repo = id(subject.get("repo")).ok_or(BadInput)?;
    let head = subject
        .get("head_sha")
        .and_then(Value::as_str)
        .filter(|s| is_sha(s))
        .ok_or(BadInput)?;
    let convener = id(o.get("convener")).ok_or(BadInput)?;
    let rule = o["rule"].as_object().ok_or(BadInput)?;
    let veto = o["veto"].as_bool().ok_or(BadInput)?;
    let quorum = o["quorum"]
        .as_u64()
        .filter(|n| *n <= MAX_INT)
        .ok_or(BadInput)?;
    let seats: Vec<&str> = o["seats"]
        .as_array()
        .ok_or(BadInput)?
        .iter()
        .map(|s| id(Some(s)))
        .collect::<Option<_>>()
        .ok_or(BadInput)?;
    let verifier = match o.get("verifier") {
        Some(v) => Some(id(Some(v)).ok_or(BadInput)?),
        None => None,
    };
    let envelopes = o["envelopes"].as_array().ok_or(BadInput)?;
    for e in envelopes {
        let ok = ["id", "type", "from", "to", "correlation_id"]
            .iter()
            .all(|k| id(e.get(*k)).is_some())
            && e.get("body").is_some_and(Value::is_object);
        if !ok {
            return Err(BadInput);
        }
    }

    let kind = rule.get("kind").and_then(Value::as_str);
    if !matches!(kind, Some("majority" | "supermajority" | "unanimity")) {
        return Err(BadPanel);
    }
    let distinct: HashSet<&str> = seats.iter().copied().collect();
    if seats.is_empty() || distinct.len() != seats.len() || distinct.contains(convener) {
        return Err(BadPanel);
    }
    if verifier.is_some_and(|v| distinct.contains(v) || v == convener) {
        return Err(BadPanel);
    }

    let str_of = |e: &Value, k: &str| {
        e.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let request_to = |member: &str| -> Result<Option<&Value>, TallyError> {
        let found: Vec<&Value> = envelopes
            .iter()
            .filter(|e| {
                let b = &e["body"];
                str_of(e, "type") == "review_request"
                    && str_of(e, "from") == convener
                    && str_of(e, "to") == member
                    && same_repo(b.get("repo"), repo)
                    && b.get("head_sha").and_then(Value::as_str) == Some(head)
            })
            .collect();
        if found.len() > 1 {
            return Err(TwoRequests);
        }
        Ok(found.first().copied())
    };
    // The review's result, when the reply that ended the request's exchange is one, for the subject's commit.
    let review_result = |request: Option<&Value>, member: &str| -> Option<&Map<String, Value>> {
        let request_id = str_of(request?, "id");
        let end = envelopes.iter().find(|e| {
            str_of(e, "correlation_id") == request_id
                && str_of(e, "from") == member
                && matches!(str_of(e, "type").as_str(), "result" | "decline")
        })?;
        if str_of(end, "type") != "result" {
            return None;
        }
        let b = end["body"].as_object()?;
        let fits = b.get("for").and_then(Value::as_str) == Some("review_request")
            && b.get("head_sha").and_then(Value::as_str) == Some(head)
            && same_repo(b.get("repo"), repo);
        let outcome = b.get("outcome").and_then(Value::as_str);
        (fits && matches!(outcome, Some("approved" | "changes_requested"))).then_some(b)
    };

    let mut ballots = Vec::new();
    let mut findings: Vec<(String, bool, &str)> = Vec::new();
    for seat in &seats {
        let Some(result) = review_result(request_to(seat)?, seat) else {
            continue;
        };
        let vote = if result["outcome"] == "approved" {
            "approve"
        } else {
            "reject"
        };
        ballots.push(json!({"seat": seat, "vote": vote}));
        for f in result
            .get("findings")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let fid = f.get("id").and_then(Value::as_str).unwrap_or_default();
            let blocking = f.get("severity").and_then(Value::as_str) == Some("blocker");
            findings.push((format!("{seat}/{fid}"), blocking, "none"));
        }
    }

    let blocking: Vec<usize> = (0..findings.len()).filter(|&i| findings[i].1).collect();
    if let Some(verifier) = verifier.filter(|_| (1..=10).contains(&blocking.len())) {
        let request = request_to(verifier)?;
        let conditions = request
            .and_then(|r| r["body"].get("acceptance"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let all_custom = conditions
            .iter()
            .all(|c| c.get("kind").and_then(Value::as_str) == Some("custom"));
        if request.is_some() && conditions.len() == blocking.len() && all_custom {
            if let Some(result) = review_result(request, verifier) {
                let mut met = HashMap::new();
                for a in result
                    .get("acceptance")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                {
                    if a.get("kind").and_then(Value::as_str) == Some("custom") {
                        if let (Some(i), Some(m)) = (
                            a.get("index").and_then(Value::as_u64),
                            a.get("met").and_then(Value::as_bool),
                        ) {
                            met.insert(i as usize, m);
                        }
                    }
                }
                for (n, &i) in blocking.iter().enumerate() {
                    if let Some(&m) = met.get(&n) {
                        findings[i].2 = if m { "stands" } else { "refuted" };
                    }
                }
            }
        }
    }

    let findings: Vec<Value> = findings
        .into_iter()
        .map(|(fid, blocking, challenge)| json!({"id": fid, "blocking": blocking, "evidence": true, "challenge": challenge}))
        .collect();
    Ok(json!({
        "rule": o["rule"],
        "quorum": quorum,
        "veto": veto,
        "seats": seats,
        "ballots": ballots,
        "findings": findings,
    }))
}
