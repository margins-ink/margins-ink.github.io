# Shooting script: "When you pay for computation"

Video replacement for the essay `src/routes/(site)/thoughts/models/+page.svx`. The video is the primary form; the post becomes the transcript and reference list. Source of every claim: the post (P) or `docs/upstream/models/SOURCE.md` (S). Exhibits: `models/exhibits/{turing,lambda,merkle}.flecs` and the `two-machines` figure (all exist; `docs/MUSEUM.md`). `docs/NARRATED.md` did not exist when this was written; align scene markers with it once it lands.

Conventions. Tags at the end of a beat: `[sourced: ...]` means the claim is in the post or SOURCE.md; `[needs source]` means it is not and must be sourced or cut before recording. `[pause]` is a breath. `[PLAY]` is a hold where the viewer touches the exhibit (video freezes on the exhibit, narration silent, a ten-to-twenty-second timer ring). `[emphasis]` marks the stressed word. Seconds include play holds. Spoken words are about 150 per minute; hold time is extra.

Writing rules applied (site CLAUDE.md): no em dashes, no "X, not Y", no restating, every sentence adds something, end each scene on the last new thing.

Total: about 8 minutes 40 seconds on screen (scene seconds sum to 520), about 1,040 spoken words (about 7 minutes of speech) plus about 100 seconds of play and thought holds. See the count at the end.

---

## Scene 1. Cold open: the line the compiler cannot write (0:00 to 0:55)

| VISUAL | NARRATION | SEC |
|---|---|---|
| Black. A code editor fades in, Lean, large type, amber caret. The code block "mkTuple" (verbatim below) types itself. Camera pushes in on `Tuple : Nat → Type`. | Here's a function. [pause] It builds a tuple. Give it three, and you get two, one, zero, and a unit. *[sourced: P, `#eval mkTuple 3 -- (2, 1, 0, ())`]* | 14 |
| Highlight `#check mkTuple 3`. Output slides in: `mkTuple 3 : Tuple 3`. Zoom on the word `Tuple` inside the type. | Look at the type. It has a three in it. [emphasis] The type depends on the value you pass in. *[sourced: P, "A value chooses a type"]* | 10 |
| Cursor selects the line `def mkTuple : (n : Nat) → Tuple n` and presses delete. Red error block (verbatim below) appears. Beat of silence. | Now I'll delete one line. Just the signature. [pause] Lean can work out types all day. It should cope. [pause] It doesn't. *[sourced: P, "Delete the signature of mkTuple and Lean 4.30 rejects it"; inference of `IO Unit` in P]* | 14 |
| Freeze on the error. A thin amber ring counts ten seconds. Caption: "Why can't the compiler write that line?" `[PLAY]` is a thought hold only (no exhibit). | Pause the video. Why can't it write that line? Guess. | 17 |

On screen, verbatim from the post (type this out, do not retype):

```lean
def Tuple : Nat → Type
  | 0 => Unit
  | n + 1 => Nat × Tuple n

def mkTuple : (n : Nat) → Tuple n
  | 0 => ()
  | n + 1 => (n, mkTuple n)

#check mkTuple 3   -- mkTuple 3 : Tuple 3
#eval mkTuple 3    -- (2, 1, 0, ())
```

Error, verbatim from the post (Lean 4.30.0, nixpkgs `lean4-4.30.0`, S):

```
error: Type mismatch
  (n, mkTuple n)
has type
  Nat × Unit
but is expected to have type
  Unit
```

---

## Scene 2. The question and the misconception (0:55 to 1:25)

| VISUAL | NARRATION | SEC |
|---|---|---|
| Hard cut to the room. The `two-machines` figure on the wall, camera wide. Top row dim: "Turing machine", "lambda calculus". Bottom row lit: "imperative languages", "functional languages", a wall between them drawn as a bold amber line. | The answer hides in a simpler question. When does a computation happen? *[sourced: P, opening sentence and dek]* | 10 |
| The line between the bottom boxes pulses. Two labels: "a machine remembers" and "nothing is remembered". | Most of us carry a picture in our heads. There are two kinds of programming. Imperative, where the machine remembers things. Functional, where you write everything down. Two camps with a wall between them. *[sourced: P, "each looks like a border between two kinds of thing"; P, "an imperative program lets the machine remember state; a functional program writes the state down as an argument"]* | 14 |
| The wall flickers. Title card: "Is that a wall?" | I'm going to show you there's no wall. | 6 |

---

## Scene 3. A tape that remembers everything (1:25 to 2:15)

| VISUAL | NARRATION | SEC |
|---|---|---|
| Camera glides to the `turing` exhibit ("A Turing machine"), preset "binary increment" loaded. Head over a tape of cells. Buttons Step, Run, Reset, speed slider visible. | Start with a Turing machine. A head sits over a tape. Each step, it reads a cell, writes a cell, moves, and changes state. *[sourced: P and `turing.flecs` Claim]* | 12 |
| `[PLAY]` 20 seconds. Viewer presses Step; amber marks the cell under the head and the rule that fires next. A tab offers "busy beaver". Narration silent. | Press step. Watch the tape. This one adds one to a binary number. | 22 |
| Camera pulls to the tape, head parked. A translucent label floats over it: "carried forward: ?". Nothing is written in the rules about carrying. | Notice what the program never says. It never says what to carry forward. The tape remembers everything, so the program doesn't have to. *[sourced: P, "The tape remembers everything, so a program never says what it carries forward"]* | 16 |

---

## Scene 4. A machine with no tape, and an order you can feel (2:15 to 3:25)

| VISUAL | NARRATION | SEC |
|---|---|---|
| Tape dissolves. The `lambda` exhibit ("A lambda term reducing") fades in, preset "succ 2" loaded, a term tree with a highlighted redex. | Now the other model. The lambda calculus has no tape. Nothing is overwritten. A program is an expression, and running it means plugging arguments into function bodies. If a later step needs something, you have to hand it over. *[sourced: P]* | 17 |
| Annotation: "2 = a function that applies its first argument twice". `[PLAY]` 20 seconds. The viewer clicks the redex to contract it, step by step. | Here, a number is a function. Two applies its first argument twice. So successor of two is a function applied to a function. Click the highlighted redex and it contracts. | 24 |
| Preset switches to "ignore omega". The toggle "normal order / applicative order" appears. Camera on the toggle. | Now the trap. The order of those steps is a choice, and the machine usually hides it. Load "ignore omega". Omega loops forever. Ignore throws its argument away. *[sourced: P, "Run `ignore omega` in both orders"; "throws its argument away" needs source]* | 14 |
| `[PLAY]` 15 seconds, viewer flips the toggle and runs both. Normal order halts; applicative order spins until `Fuel` stops it (an on-screen "stopped by fuel, it would never halt" tag). | In normal order, you never touch omega. It finishes. In applicative order, you evaluate the argument first, and it never does. [emphasis] Same term. Different order. Try both. *[sourced: P and `lambda.flecs` Claim]* | 20 |

---

## Scene 5. Two machines, one set of functions (3:25 to 3:55)

| VISUAL | NARRATION | SEC |
|---|---|---|
| Back on the `two-machines` figure. An arrow draws each way between "Turing machine" and "lambda calculus", labelled "same functions". Small card under it: "1936". | So which one is right? [pause] Both. Turing proved in nineteen thirty-six that they define the same functions. Church and Kleene tied lambda terms to the recursive functions the same year. *[sourced: P, S (Stanford Encyclopedia of Philosophy, Church-Turing)]* | 18 |
| Bottom boxes light. The wall between imperative and functional gets two arrows drawn through it. | Neither computes anything the other can't. What differs is bookkeeping. | 8 |

---

## Scene 6. The wall has a door: do-notation (3:55 to 5:00)

| VISUAL | NARRATION | SEC |
|---|---|---|
| Split screen. Left, the Lean `do` block (verbatim below, first block), imperative-looking. Camera highlights `tick` three times. | Here's a counter, written in the imperative style. Tick three times, then read it. Mutable state, right there on the screen. *[sourced: P, `threeTicks`]* | 12 |
| Right, the by-hand version (second block) slides in. Each `tick` line on the left connects by a thin line to a `let s := s + 1` line on the right. | And here's the same thing with no mutation at all. Each line just makes a new s. Lean's reference gives the rewrite. Every line of a do block becomes a function call that hands the rest of the block to the next step. Haskell's report specifies the same translation. *[sourced: P, S (Lean reference, Haskell 2010 report 3.14)]* | 24 |
| Type the `example` line (in the second block). Lean's cursor flashes, no error. Green tick. | Now I ask Lean: are these two the same? [pause] It says yes, and the proof is rfl. The two definitions are equal by unfolding alone. [emphasis] The tape came back as an argument. *[sourced: P, "Lean accepts the `rfl`"]* | 14 |
| Two portrait cards slide in: "Moggi, monads over a pure calculus" and "Wadler, a way to write programs". Placeholder portraits. Then a heap diagram with closures, labelled "STG machine, GHC". | Moggi gave effects like state a meaning as monads over a pure calculus. Wadler turned that into a way to write programs. And compilers run the conversion the other way: the machine GHC compiles Haskell to keeps unevaluated expressions as closures in a heap. *[sourced: P, S (Moggi 1991, Wadler 1992, Peyton Jones 1992)]* | 20 |

On screen, verbatim from the post:

```lean
def tick : StateM Nat Unit := modify (· + 1)

def threeTicks : StateM Nat Nat := do
  tick
  tick
  tick
  get

#eval threeTicks.run' 0   -- 3
```

```lean
def threeTicksByHand (s : Nat) : Nat × Nat :=
  let s := s + 1
  let s := s + 1
  let s := s + 1
  (s, s)

example : threeTicks = threeTicksByHand := rfl
```

---

## Scene 7. The compiler is a computer too (5:00 to 5:45)

| VISUAL | NARRATION | SEC |
|---|---|---|
| Cut to a terminal. The Rust program (verbatim below) appears. The line `// 2 + 3, worked out by the trait solver while type checking` glows amber. Output `5` prints. | Computation can also move earlier. Into the compiler. This Rust program adds two and three, and prints five. Look at where the addition happens. The trait solver does it, while the program is still being type checked. *[sourced: P, S (run with rustc 1.98.1)]* | 18 |
| Camera pulls back from the trait declarations; three logos stack: "Rust traits", "C++ templates", "TypeScript types". Each gets its source card (Leffler 2017, Veldhuizen 2003, issue 14833). | Those traits are a whole language. Shea Leffler built an interpreter for Smallfuck out of them. Veldhuizen sketched the same result for C plus plus templates. And a TypeScript issue shows it for TypeScript's types. *[sourced: P, S]* | 14 |
| A gauge climbs to "128", the terminal flashes error `E0275` and the hint line `consider increasing the recursion limit`. | The compiler has a leash. The default depth is one hundred twenty-eight. Past that, you get error E zero two seven five, and a hint to raise the limit. *[sourced: P, S (Rust reference, E0275, rustc 1.98.1)]* | 13 |

On screen, verbatim from the post:

```rust
use std::marker::PhantomData;
struct Z;
struct S<N>(PhantomData<N>);

trait Add<B> { type Out; }
impl<B> Add<B> for Z { type Out = B; }
impl<A: Add<B>, B> Add<B> for S<A> { type Out = S<A::Out>; }

trait Val { const N: u32; }
impl Val for Z { const N: u32 = 0; }
impl<N: Val> Val for S<N> { const N: u32 = N::N + 1; }

fn main() {
    // 2 + 3, worked out by the trait solver while type checking
    println!("{}", <<S<S<Z>> as Add<S<S<S<Z>>>>>::Out as Val>::N); // 5
}
```

---

## Scene 8. Back to the hook: the line only you can write (5:45 to 6:40)

| VISUAL | NARRATION | SEC |
|---|---|---|
| The hook editor returns, error still on screen. Amber marker walks the first arm of `mkTuple`, stops on `()` and writes `Unit` beside it. | Now we can answer the question I left you with. The trait solver is blind to run time. It can add two and three. It can never see a number you type. *[sourced: P, "it is blind to run time ... it can never see a number the user types"]* | 14 |
| `Tuple n` is drawn as a function from a value (a dial `n`) to a type (a tower of `Nat ×` pieces). Dial turns to three: `Nat × Nat × Nat × Unit`. | A dependent type can, because in Lean the language of types and the language of values is the same language. A value picks the type. *[sourced: P]* | 11 |
| Walk the elaborator: first arm fixes `Unit` for every n; the second arm shows `Nat × Unit` against `Unit`. A red line connects the clash. | Lean reads the first arm and decides the answer is Unit, for every n. Then the second arm says: that's a pair. To succeed, it would have to invent Tuple from the arms. A function from values to types. *[sourced: P, "The elaborator typed the first arm, fixed `Unit` for every `n`"]* | 16 |
| Dowek card with the arXiv abstract line in quotes: "some type information has to be mentioned by the programmer". The signature line `(n : Nat) → Tuple n` slides back into the code and glows. | In nineteen ninety-three, Dowek proved that working out types in the core of dependent types is undecidable. His words: some type information has to be mentioned by the programmer. [pause] So that signature is the one line inference can't write. *[sourced: P, S (Dowek, TLCA 1993; arXiv 2306.07599)]* | 17 |

---

## Scene 9. Who pays for the inference: the codebase of hashes (6:40 to 7:50)

| VISUAL | NARRATION | SEC |
|---|---|---|
| Lean editor: `def main := IO.println "hi"`. Hover tooltip `main : IO Unit` appears, then fades. Beside it, a magnifier over the plain text, which has no type in it. | Even where inference works, someone pays. Write main equals print hi, and Lean works out IO Unit. That type lives in your editor's hover. It never lives in the text, so every reader derives it again. A written signature is that work, stored once. *[sourced: P, "Inference is paid on every read"]* | 16 |
| The room tilts to the Unison wall. A definition tile splits into body and name; body goes through a hash box and gets a four-digit number, name goes to a separate label. | So what if the work could be stored for everyone, forever? Unison stores something else. A definition is identified by a hash of its syntax tree. Names are just separate metadata that don't change the hash. *[sourced: P, S (Unison, "The big idea")]* | 16 |
| `merkle` exhibit ("A codebase of hashes"): six definitions, util at the bottom. Caption: "toy hashes: four digits of FNV-1a, mine, not Unison's". `[PLAY]` 20 seconds: edit `config`, then `util`, then switch to rename and click a name. | Here's a toy codebase. The hashes are mine, not Unison's. Edit config, and parse stays reused. Edit util, and everything built on it changes. Now switch to rename, and click a name. | 28 |
| Freeze on the renamed frame: every ring unchanged. Zoom slowly. | [pause] Nothing moves. [emphasis] Nothing recompiles. | 5 |
| Three captions appear in turn over the graph (quotes from the docs): "no one has to do that ever again", "no need to rerun a deterministic test", "only missing hashes cross the wire". | The docs say it plainly. Once anyone has typechecked a definition and added it to the codebase, no one has to do that ever again. A pure test whose dependencies haven't changed doesn't rerun. And code moves to the data: the sender ships a bytecode tree, and only the hashes the other side is missing cross the wire. *[sourced: P, S (Unison "The big idea")]* | 24 |

---

## Scene 10. Effects, and where the picture breaks (7:50 to 8:15)

| VISUAL | NARRATION | SEC |
|---|---|---|
| Unison type on screen: `Nat -> Nat ->{Exception} Nat`, effect in amber. Beside it, a tape strip and a lambda strip sliding into one another. | Effects get the same treatment. In Unison, the type carries the effect, and the body reads like the tape. The docs say direct-style effects and monads have the same expressive power. *[sourced: P, S (Unison abilities)]* | 12 |
| Two edge cards: "Cost" and "Same behaviour?". The card "x + 1 / 1 + x" shows two different hashes. | The picture has edges. Church and Turing say nothing about cost. Whether a beta step is a fair unit of time stayed open until two thousand sixteen. And a hash only says two trees match. X plus one and one plus x hash differently. *[sourced: P, S (Accattoli and Dal Lago, LMCS 2016; Rice's theorem is linked in P)]* | 15 |

---

## Scene 11. The reveal and the close (8:15 to 8:40)

| VISUAL | NARRATION | SEC |
|---|---|---|
| The `two-machines` wall again. The amber wall line dissolves. A single timeline strip draws across all exhibits left to right: "compile time", "run time", "read time", "once, long ago". Chips for tape, argument, trait solver, hash slide onto it. | Functional against imperative. Program against type. Inferred against written. They look like borders between kinds of thing. Each one is a decision about when a computation runs, and who keeps the result. *[sourced: P, dek and opening]* | 14 |
| Cut to the hook editor. Cursor sits on the empty line where the signature was. The line is typed back. Error clears. Last frame holds on the caret. | A type is a computation scheduled before the program runs. A signature is one you scheduled by hand. Write it where no machine can schedule it for you. *[sourced: P, closing paragraph]* | 11 |

---

## Word count and runtime

Spoken words, by scene (counted from the NARRATION column with all `[...]`, `*[...]*` and `<...>` removed): see the table below, filled in after the script was written.

| Scene | Words |
|---|---|
| 1 | 68 |
| 2 | 59 |
| 3 | 60 |
| 4 | 124 |
| 5 | 40 |
| 6 | 146 |
| 7 | 101 |
| 8 | 137 |
| 9 | 174 |
| 10 | 75 |
| 11 | 60 |
| Total | 1044 |

---

## Exhibits and visuals that do not exist yet

Costs are lane-days of one Sonnet lane after the museum framework (MUSEUM.md convention; estimates, not measured). Existing and used as is: `turing`, `lambda`, `merkle`, `two-machines`.

| # | Visual | Used in | Cost | Note |
|---|---|---|---|---|
| 1 | `mkTuple` exhibit: slide `n`, `Tuple n` unfolds one step per click beside the value | Scenes 1 and 8 | 4 d | MUSEUM.md catalogue #5, Rewrite family, shares the lambda interpreter |
| 2 | Do-notation unroller: a `do` block that rewrites line by line into `threeTicksByHand`, with the state `s` drawn as a wire | Scene 6 | 3 d | Rewrite family; presets are the two verbatim blocks |
| 3 | Trait-solver stepper for the Rust `Add` program, showing `S<S<Z>> + S<S<S<Z>>>` unfolding to `S<S<S<S<S<Z>>>>>` and the depth gauge to 128 | Scene 7 | 3 d | Rewrite family; the post has no such figure |
| 4 | "When does it run" timeline: a strip with compile, run, read, once-long-ago slots; chips (tape, argument, solver, hash, signature) slide onto it | Scenes 2 and 11 | 4 d | Timeline family; the thesis visual, replaces the static `two-machines` wall as the closer |
| 5 | Hash-shipping exhibit: two codebases, a sender ships a tree, only missing hashes cross | Scene 9 | 2 d | Graph family, reuses `merkle` node and hash code |
| 6 | Lean editor capture: a real recorded Lean 4.30.0 session for hook and callback | Scenes 1, 6, 8, 9 | 0.5 d | Record, do not mock; or a one-off typed-in-WebGPU mock if capture is not wanted |

## Placeholders

1. Narrator voice and recording; this script is text only.
2. Music bed and the sound of the exhibits (the museum has no sound by non-goal; video sound design is separate).
3. Portrait or archive images for Turing, Church, Kleene, Moggi, Wadler, Dowek: licences not read, none stored. Use text cards until cleared.
4. Title card and thumbnail (candidate: the red `Type mismatch` block over the word `Tuple 3`).
5. Chapter names for the player (can be the scene titles above).
6. "toy hashes" caption timing in Scene 9 and the FNV-1a note: exact on-screen wording to be read back against the exhibit.
7. Scene 4 claim "Ignore throws its argument away": [needs source]; confirm against the `lazy` preset term in `lambda.flecs` or cut the sentence.
8. Sponsor or credits roll: none planned.
9. Page-load fallback: the site is WebGPU only (CLAUDE.md), so the video is also the only form for readers without WebGPU; decide whether the post stays as the transcript.

## Three alternative cold opens, ranked

1. (Favourite, used above.) The `mkTuple` puzzle: a type that computes, then the error when you delete the signature. Reason: the viewer can try it, the answer is withheld for five minutes, the callback in Scene 8 is the reveal, and every line is verbatim from the post. It earns the thesis, because the answer is that some computation can only be scheduled by hand.
2. `ignore omega`, both orders. Open on the lambda exhibit with the toggle: "Same program. One order finishes, the other never does. Which one finishes?" Viewer plays at once. Strongest on interactivity, weaker on pointing at the thesis; the callback would be that evaluation order is a scheduling choice.
3. The Rust compiler that adds. Open on the Rust program, ask "when does two plus three get computed?" The viewer is shown the answer is "while the program type checks", with the recursion-limit error as the cliffhanger. Safest on sourcing, weakest as a puzzle (the answer is visible in a comment line in the code).
