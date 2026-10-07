//! The Rewrite family: a lambda term and a beta reducer. Terms are de Bruijn trees that keep their binder names for display. A step
//! contracts one redex: the leftmost-outermost one (normal order) or the leftmost-innermost one (applicative order). Clicking the
//! `λx.` of any redex contracts that one instead. Digits in a script term are Church numerals; `Def` entities name closed terms.
use super::{draw::*, input::{Hit, Target, Ui}, kind_common::*, kind_tape::Why, model::*};
use flecs_ecs::prelude::*;

#[derive(Clone, PartialEq, Debug)]
pub enum T {
    Var(usize),
    Lam(String, Box<T>),
    App(Box<T>, Box<T>),
}

#[derive(Clone, Debug)]
pub struct RwPreset {
    pub id: String,
    pub title: String,
    pub term: T,
}

/// Nodes a term may have before the run stops (the omega-like terms that grow).
pub const MAX_NODES: usize = 400;
const MAX_DEPTH: usize = 120;
const HISTORY: usize = 3;
const MAX_LINES: usize = 4;
const SIZE: f32 = 1.0;
const CW: f32 = 0.6 * SIZE;
const PITCH: f32 = 1.5;

pub fn size(t: &T) -> usize {
    match t {
        T::Var(_) => 1,
        T::Lam(_, b) => 1 + size(b),
        T::App(f, a) => 1 + size(f) + size(a),
    }
}

// ---- reduction -------------------------------------------------------------------------------------------------------------

fn shift(t: &T, d: isize, c: usize) -> T {
    match t {
        T::Var(k) => T::Var(if *k >= c { (*k as isize + d).max(0) as usize } else { *k }),
        T::Lam(n, b) => T::Lam(n.clone(), Box::new(shift(b, d, c + 1))),
        T::App(f, a) => T::App(Box::new(shift(f, d, c)), Box::new(shift(a, d, c))),
    }
}

fn subst(t: &T, j: usize, s: &T) -> T {
    match t {
        T::Var(k) => {
            if *k == j {
                s.clone()
            } else {
                T::Var(*k)
            }
        }
        T::Lam(n, b) => T::Lam(n.clone(), Box::new(subst(b, j + 1, &shift(s, 1, 0)))),
        T::App(f, a) => T::App(Box::new(subst(f, j, s)), Box::new(subst(a, j, s))),
    }
}

pub fn beta(body: &T, arg: &T) -> T {
    shift(&subst(body, 0, &shift(arg, 1, 0)), -1, 0)
}

type Path = Vec<u8>;

fn walk(t: &T, p: &mut Path, pre: &mut Vec<Path>, post: &mut Vec<Path>) {
    let redex = matches!(t, T::App(f, _) if matches!(**f, T::Lam(..)));
    if redex {
        pre.push(p.clone());
    }
    match t {
        T::Var(_) => {}
        T::Lam(_, b) => {
            p.push(0);
            walk(b, p, pre, post);
            p.pop();
        }
        T::App(f, a) => {
            p.push(1);
            walk(f, p, pre, post);
            p.pop();
            p.push(2);
            walk(a, p, pre, post);
            p.pop();
        }
    }
    if redex {
        post.push(p.clone());
    }
}

/// (pre-order, post-order) redex paths: the first of the first is leftmost-outermost, the first of the second leftmost-innermost.
pub fn redexes(t: &T) -> (Vec<Path>, Vec<Path>) {
    let (mut pre, mut post) = (Vec::new(), Vec::new());
    walk(t, &mut Vec::new(), &mut pre, &mut post);
    (pre, post)
}

fn reduce_at(t: &T, path: &[u8]) -> Option<T> {
    match (path.split_first(), t) {
        (None, T::App(f, a)) => match &**f {
            T::Lam(_, b) => Some(beta(b, a)),
            _ => None,
        },
        (Some((0, rest)), T::Lam(n, b)) => Some(T::Lam(n.clone(), Box::new(reduce_at(b, rest)?))),
        (Some((1, rest)), T::App(f, a)) => Some(T::App(Box::new(reduce_at(f, rest)?), a.clone())),
        (Some((2, rest)), T::App(f, a)) => Some(T::App(f.clone(), Box::new(reduce_at(a, rest)?))),
        _ => None,
    }
}

/// The value of a Church numeral (`λf. λx. f (f ... x)`), if the term is one.
pub fn church(t: &T) -> Option<usize> {
    let T::Lam(_, b) = t else { return None };
    let T::Lam(_, mut b) = (**b).clone() else { return None };
    let mut n = 0;
    loop {
        match *b {
            T::Var(0) => return Some(n),
            T::App(f, a) if *f == T::Var(1) => {
                n += 1;
                b = a;
            }
            _ => return None,
        }
    }
}

// ---- printing --------------------------------------------------------------------------------------------------------------

pub struct Span {
    pub path: Path,
    /// the `λx.` token of the redex's function (char range)
    pub lam: (usize, usize),
    /// the whole redex
    pub whole: (usize, usize),
}

pub struct Render {
    pub chars: Vec<char>,
    /// every redex, inner ones first
    pub redexes: Vec<Span>,
}

struct Pr {
    chars: Vec<char>,
    redexes: Vec<Span>,
    env: Vec<String>,
    path: Path,
}

impl Pr {
    fn put(&mut self, s: &str) {
        self.chars.extend(s.chars());
    }
    fn paren(&mut self, p: bool, t: &T, fn_pos: bool) -> Option<(usize, usize)> {
        if p {
            self.put("(");
        }
        let r = self.term(t, fn_pos);
        if p {
            self.put(")");
        }
        r
    }
    /// Print `t`; for a lambda in function position the char range of its `λx.` token.
    fn term(&mut self, t: &T, fn_pos: bool) -> Option<(usize, usize)> {
        match t {
            T::Var(k) => {
                let n = self.env.len().checked_sub(1 + k).and_then(|i| self.env.get(i)).cloned().unwrap_or_else(|| format!("?{k}"));
                self.put(&n);
                None
            }
            T::Lam(name, b) => {
                let mut n = name.clone();
                while self.env.contains(&n) {
                    n.push('\'');
                }
                let s = self.chars.len();
                self.put("λ");
                self.put(&n);
                self.put(".");
                let e = self.chars.len();
                self.put(" ");
                self.env.push(n);
                self.path.push(0);
                self.term(b, false);
                self.path.pop();
                self.env.pop();
                fn_pos.then_some((s, e))
            }
            T::App(f, a) => {
                let mark = self.chars.len();
                self.path.push(1);
                let lam = self.paren(matches!(**f, T::Lam(..)), f, true);
                self.path.pop();
                self.put(" ");
                self.path.push(2);
                self.paren(matches!(**a, T::App(..) | T::Lam(..)), a, false);
                self.path.pop();
                if let Some(lam) = lam {
                    self.redexes.push(Span { path: self.path.clone(), lam, whole: (mark, self.chars.len()) });
                }
                None
            }
        }
    }
}

pub fn render(t: &T) -> Render {
    let mut p = Pr { chars: Vec::new(), redexes: Vec::new(), env: Vec::new(), path: Vec::new() };
    p.term(t, false);
    Render { chars: p.chars, redexes: p.redexes }
}

pub fn text(t: &T) -> String {
    render(t).chars.into_iter().collect()
}

/// Greedy wrap at spaces: char ranges of the lines (the space of a break belongs to no line).
fn wrap(chars: &[char], cols: usize) -> Vec<(usize, usize)> {
    let mut lines = Vec::new();
    let mut s = 0;
    while s < chars.len() {
        let hard = (s + cols).min(chars.len());
        if hard == chars.len() {
            lines.push((s, hard));
            break;
        }
        let cut = (s + 1..=hard).rev().find(|&i| chars[i] == ' ');
        match cut {
            Some(i) if i > s => {
                lines.push((s, i));
                s = i + 1;
            }
            _ => {
                lines.push((s, hard));
                s = hard;
            }
        }
    }
    lines
}

// ---- parsing and serialising -----------------------------------------------------------------------------------------------

#[derive(Debug)]
struct Parser<'a> {
    src: Vec<char>,
    i: usize,
    env: Vec<String>,
    defs: &'a [(String, T)],
    nodes: usize,
}

fn church_term(n: usize) -> T {
    let mut b = T::Var(0);
    for _ in 0..n {
        b = T::App(Box::new(T::Var(1)), Box::new(b));
    }
    T::Lam("f".into(), Box::new(T::Lam("x".into(), Box::new(b))))
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.src.len() && self.src[self.i].is_whitespace() {
            self.i += 1;
        }
    }
    fn peek(&mut self) -> Option<char> {
        self.ws();
        self.src.get(self.i).copied()
    }
    fn ident(&mut self) -> String {
        let s = self.i;
        while self.i < self.src.len() && (self.src[self.i].is_alphanumeric() || self.src[self.i] == '_' || self.src[self.i] == '\'') {
            self.i += 1;
        }
        self.src[s..self.i].iter().collect()
    }
    fn grow(&mut self, n: usize) -> Result<(), String> {
        self.nodes += n;
        if self.nodes > MAX_NODES {
            Err(format!("the term is bigger than {MAX_NODES} nodes"))
        } else {
            Ok(())
        }
    }
    fn lam(&mut self) -> Result<T, String> {
        self.i += 1;
        let mut names = Vec::new();
        loop {
            match self.peek() {
                Some('.') => {
                    self.i += 1;
                    break;
                }
                Some(c) if c.is_alphabetic() => names.push(self.ident()),
                _ => return Err(format!("expected a name or `.` after λ at character {}", self.i)),
            }
        }
        if names.is_empty() {
            return Err("λ needs at least one name".into());
        }
        if self.env.len() + names.len() > MAX_DEPTH {
            return Err("the term nests too deeply".into());
        }
        self.grow(names.len())?;
        let n = names.len();
        self.env.extend(names.iter().cloned());
        let body = self.term();
        self.env.truncate(self.env.len() - n);
        let mut t = body?;
        for name in names.into_iter().rev() {
            t = T::Lam(name, Box::new(t));
        }
        Ok(t)
    }
    fn atom(&mut self) -> Result<T, String> {
        match self.peek() {
            Some('(') => {
                self.i += 1;
                if self.env.len() > MAX_DEPTH {
                    return Err("the term nests too deeply".into());
                }
                let t = self.term()?;
                if self.peek() != Some(')') {
                    return Err(format!("expected `)` at character {}", self.i));
                }
                self.i += 1;
                Ok(t)
            }
            Some('λ') | Some('\\') => self.lam(),
            Some(c) if c.is_ascii_digit() => {
                let s = self.i;
                while self.i < self.src.len() && self.src[self.i].is_ascii_digit() {
                    self.i += 1;
                }
                let n: usize = self.src[s..self.i].iter().collect::<String>().parse().map_err(|_| "bad numeral".to_string())?;
                if n > 30 {
                    return Err(format!("numeral {n} is over 30"));
                }
                self.grow(2 * n + 3)?;
                Ok(church_term(n))
            }
            Some(c) if c.is_alphabetic() => {
                let name = self.ident();
                if let Some(k) = self.env.iter().rev().position(|n| *n == name) {
                    self.grow(1)?;
                    return Ok(T::Var(k));
                }
                match self.defs.iter().find(|(n, _)| *n == name) {
                    Some((_, t)) => {
                        self.grow(size(t))?;
                        Ok(t.clone())
                    }
                    None => Err(format!("`{name}` is neither bound nor a Def")),
                }
            }
            Some(c) => Err(format!("unexpected `{c}` at character {}", self.i)),
            None => Err("the term ends too early".into()),
        }
    }
    fn term(&mut self) -> Result<T, String> {
        let mut t = self.atom()?;
        loop {
            match self.peek() {
                None | Some(')') | Some('.') => return Ok(t),
                _ => {
                    let a = self.atom()?;
                    self.grow(1)?;
                    t = T::App(Box::new(t), Box::new(a));
                }
            }
        }
    }
}

/// Parse a script term (names resolve to binders, then to `defs`, digits are Church numerals).
pub fn parse(src: &str, defs: &[(String, T)]) -> Result<T, String> {
    let mut p = Parser { src: src.chars().collect(), i: 0, env: Vec::new(), defs, nodes: 0 };
    let t = p.term()?;
    if p.peek().is_some() {
        return Err(format!("unexpected `{}` at character {}", p.src[p.i], p.i));
    }
    Ok(t)
}

fn ser(t: &T, out: &mut String) {
    match t {
        T::Var(k) => out.push_str(&format!("#{k};")),
        T::Lam(n, b) => {
            out.push('\\');
            out.push_str(n);
            out.push(';');
            ser(b, out);
        }
        T::App(f, a) => {
            out.push('@');
            ser(f, out);
            ser(a, out);
        }
    }
}

fn de(c: &[char], i: &mut usize, depth: usize, nodes: &mut usize) -> Option<T> {
    *nodes += 1;
    if *nodes > MAX_NODES || depth > MAX_NODES {
        return None;
    }
    let ch = *c.get(*i)?;
    *i += 1;
    let word = |i: &mut usize| -> Option<String> {
        let s = *i;
        while *c.get(*i)? != ';' {
            *i += 1;
        }
        let w: String = c[s..*i].iter().collect();
        *i += 1;
        Some(w)
    };
    match ch {
        '#' => {
            let k: usize = word(i)?.parse().ok()?;
            (k < depth).then_some(T::Var(k))
        }
        '\\' => {
            let n = word(i)?;
            (!n.is_empty() && n.chars().all(|x| x.is_alphanumeric() || x == '_' || x == '\'')).then_some(())?;
            Some(T::Lam(n, Box::new(de(c, i, depth + 1, nodes)?)))
        }
        '@' => {
            let f = de(c, i, depth, nodes)?;
            let a = de(c, i, depth, nodes)?;
            Some(T::App(Box::new(f), Box::new(a)))
        }
        _ => None,
    }
}

// ---- reading the script ------------------------------------------------------------------------------------------------------

pub fn read(w: &World, voc: &Voc, scope: EntityView) -> Result<Vec<RwPreset>, String> {
    let def_proto = w.try_lookup("Def").ok_or("prefab `Def` is missing")?.id();
    // Entity ids are not declaration order once a scope has been rebuilt, so Defs are resolved by name: repeat until no more parse.
    let mut pending: Vec<(EntityView, String)> = Vec::new();
    let mut presets_src: Vec<(EntityView, String)> = Vec::new();
    for c in children(scope) {
        let term_src = c.try_cloned::<&Lambda>().map(|t| t.text);
        if is_a(c, def_proto) {
            pending.push((c, term_src.ok_or_else(|| format!("{}: a Def needs a Lambda text", path(c)))?));
        } else if is_a(c, voc.preset) {
            presets_src.push((c, term_src.ok_or_else(|| format!("{}: a Preset needs a Lambda text", path(c)))?));
        }
    }
    let mut defs: Vec<(String, T)> = Vec::new();
    while !pending.is_empty() {
        let before = pending.len();
        let mut rest = Vec::new();
        let mut last_err = String::new();
        for (c, src) in pending {
            match parse(&src, &defs) {
                Ok(t) => defs.push((c.name(), t)),
                Err(e) => {
                    last_err = format!("{}: {e}", path(c));
                    rest.push((c, src));
                }
            }
        }
        if rest.len() == before {
            return Err(last_err);
        }
        pending = rest;
    }
    let mut presets = Vec::new();
    for (c, src) in presets_src {
        let term = parse(&src, &defs).map_err(|e| format!("{}: {e}", path(c)))?;
        presets.push(RwPreset { id: c.name(), title: c.try_cloned::<&Title>().map(|t| t.text).unwrap_or_default(), term });
    }
    Ok(presets)
}

// ---- the core --------------------------------------------------------------------------------------------------------------

pub struct Rw {
    term: T,
    applicative: bool,
    hist: Vec<String>,
    r: Render,
    /// index into `r.redexes` of the redex the strategy contracts next
    pending: Option<usize>,
}

impl Rw {
    pub fn new(def: &ExDef) -> Rw {
        let mut s = Rw { term: T::Var(0), applicative: false, hist: Vec::new(), r: Render { chars: Vec::new(), redexes: Vec::new() }, pending: None };
        s.load(def, 0);
        s
    }

    fn refresh(&mut self) {
        self.r = render(&self.term);
        let (pre, post) = redexes(&self.term);
        let pick = if self.applicative { post.first() } else { pre.first() };
        self.pending = pick.and_then(|p| self.r.redexes.iter().position(|s| s.path == *p));
    }

    fn contract(&mut self, path: &[u8]) -> Out {
        let Some(next) = reduce_at(&self.term, path) else { return Out { moved: false, halt: None } };
        self.hist.insert(0, self.r.chars.iter().collect());
        self.hist.truncate(HISTORY);
        self.term = next;
        self.refresh();
        let halt = if self.r.redexes.is_empty() {
            Some(Why::Accept)
        } else if size(&self.term) > MAX_NODES - 40 {
            Some(Why::Fuel)
        } else {
            None
        };
        Out { moved: true, halt }
    }

    fn geometry(&self, def: &ExDef) -> (f32, f32, usize, Vec<(usize, usize)>) {
        let v = view(def);
        let cols = (((v[2] - 1.0) / CW).floor() as usize).max(8);
        (v[0] + 0.5, v[1] + 2.4, cols, wrap(&self.r.chars, cols))
    }
}

/// Segments (line, first col, last col exclusive) of a char span over wrapped lines.
fn segments(lines: &[(usize, usize)], a: usize, b: usize) -> Vec<(usize, usize, usize)> {
    lines.iter().enumerate().filter_map(|(k, &(s, e))| {
        let (x0, x1) = (a.max(s), b.min(e));
        (x1 > x0).then_some((k, x0 - s, x1 - s))
    }).collect()
}

impl Core for Rw {
    fn tag(&self) -> &'static str {
        "rw1"
    }

    fn load(&mut self, def: &ExDef, i: usize) {
        if let Data::Rewrite(v) = &def.data {
            if let Some(p) = v.get(i) {
                self.term = p.term.clone();
            }
        }
        self.hist.clear();
        self.refresh();
    }

    fn step(&mut self, _def: &ExDef, _preset: usize) -> Out {
        match self.pending {
            Some(i) => {
                let path = self.r.redexes[i].path.clone();
                self.contract(&path)
            }
            None => Out { moved: false, halt: Some(Why::Accept) },
        }
    }

    fn toggle(&mut self, _def: &ExDef, _preset: usize) -> Act {
        self.applicative = !self.applicative;
        self.refresh();
        Act::None
    }

    fn toggled(&self) -> bool {
        self.applicative
    }

    fn activate(&mut self, _def: &ExDef, _preset: usize, t: Target, can_step: bool) -> Act {
        match t {
            Target::Item(i, 0) if can_step => match self.r.redexes.get(i) {
                Some(s) => {
                    let path = s.path.clone();
                    let o = self.contract(&path);
                    if o.moved {
                        Act::Step(o.halt)
                    } else {
                        Act::None
                    }
                }
                None => Act::None,
            },
            _ => Act::None,
        }
    }

    fn hits(&self, def: &ExDef, out: &mut Vec<Hit>) {
        let (x0, y0, _, lines) = self.geometry(def);
        let layer = def.part(PartKind::View).map_or(1, |p| p.layer);
        for (i, s) in self.r.redexes.iter().enumerate() {
            for (k, c0, c1) in segments(&lines, s.lam.0, s.lam.1) {
                if k < MAX_LINES {
                    let base = y0 + PITCH * k as f32;
                    out.push(Hit { rect: [x0 + c0 as f32 * CW - 0.1, base - 1.0, (c1 - c0) as f32 * CW + 0.2, 1.35], layer, target: Target::Item(i, 0) });
                }
            }
        }
    }

    fn draw(&self, def: &ExDef, ui: &Ui, dl: &mut DrawList) {
        let v = view(def);
        let (x0, y0, _, lines) = self.geometry(def);
        let hov = |t: Target| if ui.hover == Some(t) { F_HOVER } else { 0 } | if ui.pressed == Some(t) { F_PRESSED } else { 0 };
        dl.label(x0, v[1] + 1.0, 0.75, 0.0, if self.applicative { "term, innermost redex first" } else { "term, outermost redex first" }, INK3, 0);
        // the redex the strategy contracts next
        if let Some(p) = self.pending {
            for (k, c0, c1) in segments(&lines, self.r.redexes[p].whole.0, self.r.redexes[p].whole.1) {
                if k < MAX_LINES {
                    dl.rrect([x0 + c0 as f32 * CW - 0.15, y0 + PITCH * k as f32 - 1.0, (c1 - c0) as f32 * CW + 0.3, 1.35], 0.25, ACCENT_TINT, F_PENDING);
                }
            }
        }
        // a chip behind the λ of every redex: the click target
        for (i, s) in self.r.redexes.iter().enumerate() {
            for (k, c0, c1) in segments(&lines, s.lam.0, s.lam.1) {
                if k < MAX_LINES {
                    let rect = [x0 + c0 as f32 * CW - 0.1, y0 + PITCH * k as f32 - 1.0, (c1 - c0) as f32 * CW + 0.2, 1.35];
                    dl.rrect(rect, 0.25, PANEL_HI, hov(Target::Item(i, 0)) | if self.pending == Some(i) { F_SELECTED } else { 0 });
                }
            }
        }
        for (k, &(s, e)) in lines.iter().take(MAX_LINES).enumerate() {
            let mut line: String = self.r.chars[s..e].iter().collect();
            if k + 1 == MAX_LINES && lines.len() > MAX_LINES {
                line.push('…');
            }
            dl.label(x0, y0 + PITCH * k as f32, SIZE, 0.0, &line, INK, F_MONO);
        }
        if !self.hist.is_empty() {
            dl.label(x0, v[1] + 8.0, 0.75, 0.0, "before", INK3, 0);
            for (j, h) in self.hist.iter().enumerate() {
                dl.label(x0, v[1] + 9.2 + 1.1 * j as f32, 0.8, v[2] - 1.0, h, INK3, F_MONO);
            }
        }
    }

    fn status(&self, _def: &ExDef, run: &Run) -> String {
        let n = self.r.redexes.len();
        match run.halted {
            Some(Why::Accept) => match church(&self.term) {
                Some(c) => format!("step {}   normal form: the Church numeral {c}", run.steps),
                None => format!("step {}   normal form", run.steps),
            },
            Some(Why::NoRule) => format!("step {}   stuck", run.steps),
            Some(Why::Fuel) => format!("step {}   stopped: out of fuel, no normal form reached", run.steps),
            None => format!("step {}   {} {}{}", run.steps, n, if n == 1 { "redex" } else { "redexes" }, if run.running { "   running" } else { "" }),
        }
    }

    fn save(&self) -> String {
        // printed terms hold no `;` and no U+0001, so the history needs no escaping
        let mut s = format!("{};{};", self.applicative as u8, self.hist.join("\u{1}"));
        ser(&self.term, &mut s);
        s
    }

    fn restore(&mut self, _def: &ExDef, _preset: usize, s: &str, _steps: u32) -> bool {
        let mut f = s.splitn(3, ';');
        let (Some(a), Some(hist), Some(rest)) = (f.next(), f.next(), f.next()) else { return false };
        let applicative = match a {
            "0" => false,
            "1" => true,
            _ => return false,
        };
        let c: Vec<char> = rest.chars().collect();
        let (mut i, mut nodes) = (0, 0);
        let Some(t) = de(&c, &mut i, 0, &mut nodes) else { return false };
        if i != c.len() {
            return false;
        }
        self.term = t;
        self.applicative = applicative;
        self.hist = if hist.is_empty() { Vec::new() } else { hist.split('\u{1}').take(HISTORY).map(String::from).collect() };
        self.refresh();
        true
    }
}
