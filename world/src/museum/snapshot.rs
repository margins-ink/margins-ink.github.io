//! Snapshot text: `<fnv1a32 of the script, 8 hex>:<family payload>`. The reader base64url-encodes it into `#x:<id>=<blob>`.
pub fn fnv1a(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

pub fn wrap(hash: u32, payload: &str) -> String {
    format!("{hash:08x}:{payload}")
}

/// Split a snapshot into (hash, payload); `None` when malformed.
pub fn unwrap(text: &str) -> Option<(u32, &str)> {
    let (h, p) = text.split_once(':')?;
    (h.len() == 8).then_some(())?;
    Some((u32::from_str_radix(h, 16).ok()?, p))
}

pub fn hex(s: &str) -> Option<u32> {
    u32::from_str_radix(s, 16).ok()
}

pub fn num<T: std::str::FromStr>(s: &str) -> Option<T> {
    s.parse().ok()
}
