# JS/TS Dataflow Analysis: Pure SAST vs SAST + LLM  
Context, Tradeoffs, and Recommended Architectures

---

## 1. Conversation Context (Full Summary)

We are designing a **JS/TS-only dataflow analysis system** with the following constraints and goals:

### Constraints
- **Single engineer**
- **Unlimited Codex (LLM) access**
- **JS/TS only**
- **No requirement to detect vulnerabilities directly**
- **No reliance on Semgrep rules**
- **No Semgrep Cloud**
- **Call graph already provided by `cs-au-dk/Jelly`**
- **LGPL constraints respected (tools invoked as subprocesses or external engines)**

### Goals
- Extract **possible dataflows** (not necessarily exact or complete)
- Interprocedural flow is **useful and desired**
- Exact paths are **nice to have**, but **possible-flow edges are acceptable**
- Output should be **flow facts**, not “findings”
- System should be usable as **infrastructure**, not a scanner product

### Key conclusions reached earlier
- Rebuilding a full static analyzer from scratch is **months of work**
- Jelly removes the hardest part: **call graph construction**
- Remaining hard parts:
  - intra-procedural flow
  - heap/object approximation
  - argument mapping
  - async/callback modeling
- Two viable implementation strategies emerged:
  1. **Pure SAST (deterministic static analysis)**
  2. **Hybrid SAST + LLM (LLM-assisted intra-procedural extraction)**

This document formalizes both approaches.

---

## 2. Approach A: Pure SAST (Deterministic Static Analysis)

### High-level idea
Build a traditional static dataflow engine:
- Deterministic
- Rule-based
- CFG + summaries + fixpoint propagation
- Jelly provides the interprocedural call graph

LLMs are not involved in the analysis itself.

---

### Architecture

1. **Parsing**
   - Use TypeScript compiler API
   - Extract AST, scopes, symbols, spans

2. **Function Identification**
   - Stable `FuncId = (file, startOffset, endOffset)`
   - Map Jelly call graph nodes → `FuncId`

3. **Intra-procedural Analysis**
   - Build per-function CFG (or simplified block graph)
   - Forward dataflow (taint-style or dependency-style)
   - Track:
     - Param → local
     - Local → local
     - Local/param → return
     - Local/param → call arguments
     - Local/param → heap writes
     - Heap reads → locals / return / call args

4. **Heap Model (Coarse)**
   - Heap buckets only:
     - `(allocationSite, propertyName)`
     - `(allocationSite, "*")` for dynamic keys
   - No points-to precision

5. **Function Summaries**
   - Output facts like:
     - `Param[i] -> Return`
     - `Param[i] -> CallArg(callsite, j)`
     - `Param[i] -> HeapWrite(bucket)`
     - `HeapRead(bucket) -> Return`

6. **Interprocedural Propagation**
   - Use Jelly call graph
   - Fixpoint over summaries
   - No or limited context sensitivity

7. **Witnesses (Optional)**
   - Call-chain witnesses: easy
   - Line-level paths: hard (extra bookkeeping)

---

### Output
- Deterministic flow facts
- Example:
  - `FLOW_PARAM_TO_RETURN`
  - `FLOW_PARAM_TO_CALLARG`
  - `FLOW_HEAP_TO_RETURN`

---

### Effort Estimate (Single Engineer)
- Intra-proc summaries: 4–8 weeks
- Interproc propagation: 1–3 weeks
- Call-chain witnesses: ~1 week
- Line-level paths: +3–6 weeks

**Total to useful system:** ~2–3 months  
**Total to “nice paths”:** ~3–4 months

---

### Pros
- Deterministic
- Reproducible
- Easy to test and diff
- No runtime inference risk
- Easier to reason about correctness

### Cons
- Slow to build
- CFG + edge cases are painful
- JS/TS dynamic features reduce precision
- High engineering cost up front

---

## 3. Approach B: Hybrid SAST + LLM (LLM-assisted Intra-Procedural)

### High-level idea
Use **LLMs to replace or assist intra-procedural analysis**, while keeping:
- Parsing
- Call graph
- Interprocedural propagation
- Output semantics

fully deterministic.

The LLM is **not trusted to invent semantics**, only to extract structured facts.

---

### Where the LLM is used
Only **inside a function**, never across functions.

Possible roles:
1. Extract dependency edges
2. Generate function summaries
3. Fill gaps missed by cheap syntactic analysis

The LLM never:
- Builds the call graph
- Propagates across functions
- Invents new variables or heap locations
- Emits final “findings”

---

### Recommended Hybrid Pipeline

1. **Deterministic Frontend**
   - Parse TS → AST
   - Assign IDs:
     - `v1`, `v2` for locals/params
     - `h1` for heap buckets
     - `s1`, `s2` for statements

2. **IR Construction**
   - Linearized, bounded IR:
     - assignments
     - calls
     - returns
     - member reads/writes
     - awaits
   - No raw source code if possible

3. **Cheap Static Pass**
   - Always extract:
     - `x = y`
     - `return expr`
     - `f(a,b)`
     - `obj.x = y`
     - `y = obj.x`

4. **LLM Invocation**
   - Input:
     - IR
     - variable IDs
     - heap bucket IDs
   - Output (strict schema):
     - dependency edges
     - param → return flags
     - param → callarg flags
     - param → heapwrite flags

5. **Validation Layer**
   - Reject output if:
     - unknown IDs
     - missing mandatory edges
     - excessive edges
   - Retry with corrective prompt if needed

6. **Caching**
   - Hash function IR
   - Cache summaries aggressively

7. **Interprocedural Phase**
   - Same as pure SAST
   - Jelly call graph + fixpoint

---

### What the LLM is Good At
- Destructuring semantics
- Ternaries, short-circuiting
- Optional chaining
- Spread operators
- Idiomatic JS patterns
- “Glue logic” humans write

### What the LLM Must Not Do
- Invent control flow
- Emit full paths
- Decide reachability
- Decide vulnerability relevance

---

### Output
Same as pure SAST:
- Function summaries
- Interprocedural flow facts
- Optional call-chain witnesses

---

### Effort Estimate (Single Engineer + Codex)
- IR + validation framework: 1–2 weeks
- LLM summary extraction: 1–2 weeks
- Interproc propagation: 1–2 weeks
- Stabilization + retries: ongoing

**Time to useful system:** ~3–5 weeks  
**Time to stable system:** ~1–2 months

---

### Pros
- Much faster to first result
- Avoids CFG + fixpoint complexity intra-proc
- Handles messy JS better
- Easier to evolve via prompt iteration

### Cons
- Nondeterminism (must be controlled)
- Runtime cost
- Requires careful validation
- Harder to claim formal soundness

---

## 4. Comparative Summary

| Dimension | Pure SAST | SAST + LLM |
|---------|-----------|------------|
| Determinism | High | Medium (guarded) |
| Time to MVP | Slow | Fast |
| JS/TS Idioms | Painful | Strong |
| Engineering Cost | High upfront | Lower upfront |
| Debuggability | High | Medium |
| Precision Ceiling | Higher | Lower but sufficient |
| Maintenance | Code-heavy | Prompt-heavy |

---

## 5. Recommendation Given Your Constraints

Given:
- Jelly already provides call graph
- Possible flow is acceptable
- Single engineer
- Unlimited Codex

**Recommended path:**
1. Hybrid SAST + LLM for intra-procedural summaries
2. Deterministic interprocedural propagation
3. Emit flow facts, not findings
4. Add exact paths later if needed

This minimizes time-to-value while keeping architectural control.

---

## 6. North Star
Treat the system as a **flow fact generator**, not a vulnerability scanner.

Everything downstream (ranking, security meaning, LLM reasoning, UI) should be:
- replaceable
- decoupled
- policy-free

This keeps the core analysis small, fast, and durable.
