//! The timeline: where every scene, line, word and beat sits in film time, and the pure function from a time to a stage state.
//!
//! Film time is one clock for the whole film (the voice file's clock). Scene k starts when scene k-1 ends; a line starts `gap` seconds after
//! the previous line ended (the first line of a scene `lead` after the scene start); a scene ends `tail` seconds after its last line.
//! With aligned audio a line's start, duration and word times are the file's; without it they are the reading-speed estimate below, so the
//! film plays the same before and after the voice exists, only the numbers move. Nothing here integrates `dt`: `eval(t)` depends on the
//! definition, the alignment and `t` only (seek equals play by construction; the test hashes `eval` after irregular frame sequences).
use super::model::*;
use std::collections::HashMap;

/// Words per second of the timer estimate (156 wpm, a typical explainer pace) and the pauses it adds.
pub const WORDS_PER_SEC: f32 = 2.6;
pub const COMMA_PAUSE: f32 = 0.18;
pub const STOP_PAUSE: f32 = 0.45;
/// `[pause]` inside a spoken line (also what the audio pipeline inserts).
pub const MARK_PAUSE: f32 = 0.35;
/// Default silence between two lines of a scene.
pub const LINE_GAP: f32 = 0.25;

/// A line of aligned audio: absolute start, duration and per-word [start, end] in film time.
#[derive(Clone, Debug, Default)]
pub struct Aligned {
    pub start: f32,
    pub dur: f32,
    pub words: Vec<(f32, f32)>,
}

/// Aligned audio by Say name, scene-qualified (`scene/say`).
pub type AlignMap = HashMap<String, Aligned>;

/// The spoken words of a line as the voice reads them: `*emphasis*` marks and `[pause]` tokens are not words.
pub fn spoken_words(spoken: &str) -> Vec<String> {
    spoken
        .replace("[pause]", " ")
        .split_whitespace()
        .map(|w| w.trim_matches('*').to_string())
        .filter(|w| !w.is_empty())
        .collect()
}

/// The caption words of a line (what is drawn).
pub fn text_words(text: &str) -> Vec<String> {
    text.split_whitespace().map(|w| w.to_string()).collect()
}

/// Reading-speed estimate: (duration, per-word [start, end]) relative to the line start.
pub fn estimate(spoken: &str) -> (f32, Vec<(f32, f32)>) {
    let mut t = 0.0f32;
    let mut out = Vec::new();
    let mut marks = spoken.split("[pause]").peekable();
    while let Some(part) = marks.next() {
        for raw in part.split_whitespace() {
            let w = raw.trim_matches('*');
            if w.is_empty() {
                continue;
            }
            // longer words take longer: 1/WORDS_PER_SEC is the mean, scaled by length around 5 letters
            let letters = w.chars().filter(|c| c.is_alphanumeric()).count().max(1) as f32;
            let d = (1.0 / WORDS_PER_SEC) * (0.55 + 0.09 * letters).clamp(0.5, 1.6);
            out.push((t, t + d));
            t += d;
            match raw.chars().last() {
                Some(',') | Some(';') | Some(':') => t += COMMA_PAUSE,
                Some('.') | Some('?') | Some('!') => t += STOP_PAUSE,
                _ => {}
            }
        }
        if marks.peek().is_some() {
            t += MARK_PAUSE;
        }
    }
    (t, out)
}

#[derive(Clone, Debug)]
pub struct SayT {
    pub start: f32,
    pub dur: f32,
    pub gap: f32,
    pub aligned: bool,
    /// per spoken word, absolute film time
    pub words: Vec<(f32, f32)>,
}

#[derive(Clone, Debug)]
pub struct BeatT {
    /// absolute film time
    pub t: f32,
    pub idx: usize,
}

#[derive(Clone, Debug)]
pub struct SceneT {
    pub start: f32,
    pub end: f32,
    pub says: Vec<SayT>,
    /// beats in (time, order, declaration) order
    pub beats: Vec<BeatT>,
}

#[derive(Clone, Debug)]
pub struct Timeline {
    pub scenes: Vec<SceneT>,
    pub total: f32,
}

/// The silence authored before line `i` of a scene: the first line follows the scene's lead (plus the previous scene's tail, which the voice
/// file carries as silence), later lines their `Gap` or the default.
pub fn authored_gap(def: &FilmDef, scene: usize, say: usize) -> f32 {
    let s = &def.scenes[scene];
    if say == 0 {
        let prev_tail = if scene == 0 { 0.0 } else { def.scenes[scene - 1].tail };
        return s.lead + prev_tail;
    }
    s.says[say].gap.unwrap_or(LINE_GAP)
}

/// Key of an aligned line: `scene/say`.
pub fn say_key(def: &FilmDef, scene: usize, say: usize) -> String {
    format!("{}/{}", def.scenes[scene].name, def.scenes[scene].says[say].name)
}

fn word_time(says: &[SayT], si: usize, n: i32, lead: f32) -> f32 {
    let s = &says[si];
    let base = if n < 0 || s.words.is_empty() {
        s.start + s.dur
    } else {
        let i = (n as usize).min(s.words.len() - 1);
        s.words[i].0
    };
    base + lead
}

pub fn build(def: &FilmDef, align: &AlignMap) -> Result<Timeline, String> {
    let mut scenes: Vec<SceneT> = Vec::new();
    let mut cursor = 0.0f32; // the end of the previous scene
    let mut last_say_end = 0.0f32;
    for (si, sc) in def.scenes.iter().enumerate() {
        let start = cursor;
        let mut says: Vec<SayT> = Vec::new();
        let mut prev_end = if si == 0 { 0.0 } else { last_say_end };
        for (qi, sy) in sc.says.iter().enumerate() {
            let gap = authored_gap(def, si, qi);
            let key = say_key(def, si, qi);
            let sw = spoken_words(&sy.spoken);
            let (start_q, dur, words, aligned) = match align.get(&key) {
                Some(a) if !a.words.is_empty() => (a.start, a.dur, a.words.clone(), true),
                _ => {
                    let (d, rel) = estimate(&sy.spoken);
                    let s0 = prev_end + gap;
                    (s0, d, rel.iter().map(|(a, b)| (s0 + a, s0 + b)).collect::<Vec<_>>(), false)
                }
            };
            // aligned words that do not match the spoken words one to one are laid proportionally over the same span
            let words = if words.len() == sw.len() || sw.is_empty() {
                words
            } else {
                let n = sw.len();
                (0..n)
                    .map(|i| {
                        let f0 = i as f32 / n as f32;
                        let f1 = (i + 1) as f32 / n as f32;
                        (start_q + f0 * dur, start_q + f1 * dur)
                    })
                    .collect()
            };
            prev_end = start_q + dur;
            says.push(SayT { start: start_q, dur, gap, aligned, words });
        }
        last_say_end = prev_end;
        let speech_end = if sc.says.is_empty() { start } else { prev_end };
        // a hold (Await) extends the timeline by its own seconds: the lines after it carry the silence in their gap, so nothing to add here.
        let mut end = speech_end + if sc.says.is_empty() { 0.0 } else { sc.tail };
        if let Some(d) = sc.dur {
            if sc.says.is_empty() {
                end = start + d;
            }
        }
        // resolve beat times in dependency order (After targets declared before)
        let mut times: Vec<Option<f32>> = vec![None; sc.beats.len()];
        let mut remaining = sc.beats.len();
        let mut guard = 0;
        while remaining > 0 {
            guard += 1;
            if guard > sc.beats.len() + 2 {
                return Err(format!("{}: beat times form a cycle", sc.name));
            }
            for (bi, b) in sc.beats.iter().enumerate() {
                if times[bi].is_some() {
                    continue;
                }
                let t = if let Some(a) = b.at {
                    Some(start + a)
                } else if let Some((qi, n, lead)) = b.pin {
                    if n >= 0 && (n as usize) >= says[qi].words.len().max(1) && !says[qi].words.is_empty() {
                        return Err(format!("{}: word {} is past the last word ({}) of {}", b.path, n, says[qi].words.len(), sc.says[qi].name));
                    }
                    Some(word_time(&says, qi, n, lead))
                } else if let Some((ai, delay)) = b.after {
                    times[ai].map(|t0| t0 + beat_len(&sc.beats[ai].action) + delay)
                } else {
                    None
                };
                if let Some(t) = t {
                    times[bi] = Some(t);
                    remaining -= 1;
                }
            }
        }
        let mut beats: Vec<BeatT> = times.iter().enumerate().map(|(idx, t)| BeatT { t: t.unwrap(), idx }).collect();
        beats.sort_by(|a, b| {
            let (ba, bb) = (&sc.beats[a.idx], &sc.beats[b.idx]);
            a.t.partial_cmp(&b.t).unwrap().then(ba.order.cmp(&bb.order)).then(ba.seq.cmp(&bb.seq))
        });
        // a beat that ends after the scene stretches it a little: nothing is cut off
        for b in &beats {
            end = end.max(b.t + beat_len(&sc.beats[b.idx].action).min(2.0));
        }
        cursor = end;
        scenes.push(SceneT { start, end, says, beats });
    }
    Ok(Timeline { total: cursor, scenes })
}

/// Seconds a beat takes (what `After` waits for).
pub fn beat_len(a: &Action) -> f32 {
    match a {
        Action::Tween { dur, .. } => *dur,
        Action::Ring { dur } => *dur,
        _ => 0.0,
    }
}

// ---- state at a time ----

/// Everything numeric a prop shows at one time.
#[derive(Clone, Copy, Debug, Default)]
pub struct PropS {
    pub pos: [f32; 2],
    pub size: [f32; 2],
    pub alpha: f32,
    pub em: f32,
    pub rad: f32,
    pub stroke: f32,
    pub reveal: f32,
    pub lit: f32,
}

#[derive(Clone, Debug)]
pub struct FrameS {
    pub scene: usize,
    /// seconds into the scene
    pub ts: f32,
    pub cam: [f32; 3],
    pub props: Vec<PropS>,
    /// per prop: (seconds since each Ring beat that is still alive, dur)
    pub rings: Vec<Vec<(f32, f32)>>,
    /// per prop: the Bursts so far (seconds since, count)
    pub bursts: Vec<Vec<(f32, u32)>>,
}

fn path_slot(p: &mut PropS, path: &str) -> Option<*mut f32> {
    Some(match path {
        "Alpha.a" => &mut p.alpha,
        "Pos.x" => &mut p.pos[0],
        "Pos.y" => &mut p.pos[1],
        "Size.w" => &mut p.size[0],
        "Size.h" => &mut p.size[1],
        "Em.n" => &mut p.em,
        "Rad.r" => &mut p.rad,
        "Stroke.w" => &mut p.stroke,
        "Reveal.f" => &mut p.reveal,
        "Lit.line" => &mut p.lit,
        _ => return None,
    })
}

/// Value of one path at time `t`: the chain of tweens in time order, each starting from the value the chain had at its start.
fn chain_value(v0: f32, chain: &[(f32, f32, f32, Ease)], t: f32) -> f32 {
    // chain: (t0, to, dur, ease), sorted by t0
    let mut v = v0;
    for (i, &(t0, to, dur, ease)) in chain.iter().enumerate() {
        if t < t0 {
            break;
        }
        let from = if i == 0 { v0 } else { chain_value(v0, &chain[..i], t0) };
        v = if dur <= 0.0 || t >= t0 + dur { to } else { from + (to - from) * ease.at((t - t0) / dur) };
    }
    v
}

pub fn eval(def: &FilmDef, tl: &Timeline, t: f32) -> FrameS {
    let t = t.clamp(0.0, tl.total.max(0.0));
    let si = tl.scenes.iter().rposition(|s| s.start <= t).unwrap_or(0).min(tl.scenes.len() - 1);
    let sc = &def.scenes[si];
    let st = &tl.scenes[si];
    let mut props: Vec<PropS> = sc
        .props
        .iter()
        .map(|p| PropS { pos: p.pos, size: p.size, alpha: p.alpha, em: p.em, rad: p.rad, stroke: p.stroke, reveal: p.reveal, lit: p.lit })
        .collect();
    let mut rings: Vec<Vec<(f32, f32)>> = vec![Vec::new(); sc.props.len()];
    let mut bursts: Vec<Vec<(f32, u32)>> = vec![Vec::new(); sc.props.len()];
    let mut cam = sc.cam;
    // gather tween chains per (target, path)
    let mut chains: HashMap<(usize, &str), Vec<(f32, f32, f32, Ease)>> = HashMap::new();
    for b in &st.beats {
        let bd = &sc.beats[b.idx];
        match &bd.action {
            Action::Tween { path, to, dur, ease } => {
                let key = (bd.target.unwrap_or(usize::MAX), path.as_str());
                chains.entry(key).or_default().push((b.t, *to, *dur, *ease));
            }
            Action::Ring { dur } => {
                if let Some(ti) = bd.target {
                    if t >= b.t && t < b.t + dur {
                        rings[ti].push((t - b.t, *dur));
                    }
                }
            }
            Action::Burst { n } => {
                if let Some(ti) = bd.target {
                    if t >= b.t {
                        bursts[ti].push((t - b.t, *n));
                    }
                }
            }
            _ => {}
        }
    }
    for ((target, path), chain) in &chains {
        if *target == usize::MAX {
            let slot = match *path {
                "Cam.x" => 0,
                "Cam.y" => 1,
                "Cam.zoom" => 2,
                _ => continue,
            };
            cam[slot] = chain_value(cam[slot], chain, t);
        } else if let Some(slot) = path_slot(&mut props[*target], path) {
            // SAFETY: `slot` points into `props[*target]`, which is alive and not otherwise borrowed in this block.
            unsafe { *slot = chain_value(*slot, chain, t) };
        }
    }
    FrameS { scene: si, ts: t - st.start, cam, props, rings, bursts }
}

/// The exhibit commands of the scene up to `t`, per mount prop: (time, verb, n). Gates and seeks replay these in order.
pub fn commands(def: &FilmDef, tl: &Timeline, scene: usize) -> Vec<(usize, f32, String, u32)> {
    let sc = &def.scenes[scene];
    let mut out = Vec::new();
    for b in &tl.scenes[scene].beats {
        let bd = &sc.beats[b.idx];
        if let (Action::Do { verb, n }, Some(ti)) = (&bd.action, bd.target) {
            out.push((ti, b.t, verb.clone(), *n));
        }
    }
    out
}

/// Gates of a scene: (start, hold seconds, until, n, mount prop index).
pub fn gates(def: &FilmDef, tl: &Timeline, scene: usize) -> Vec<(f32, f32, String, u32, Option<usize>)> {
    let sc = &def.scenes[scene];
    let mut out = Vec::new();
    for b in &tl.scenes[scene].beats {
        let bd = &sc.beats[b.idx];
        if let Action::Await { until, n, hold } = &bd.action {
            if *hold <= 0.0 {
                continue;
            }
            out.push((b.t, *hold, until.clone(), *n, bd.target));
        }
    }
    out
}
