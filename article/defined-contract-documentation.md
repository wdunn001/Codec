# Defined Contract Documentation Is Beating Your AI Stack

Companies are spending heavily to solve a problem that good engineering already solved.

The current wave of AI tooling investment is going into systems designed to give models architectural awareness across a codebase. Vector embeddings of every file. Semantic search over design docs. Custom agents that walk dependency graphs before generating code. Retrieval pipelines stitched into IDEs. The premise is reasonable: AI struggles to maintain consistency across a system, so feed it more of the system on every request.

The premise is also expensive, fragile, and unnecessary for a class of problems that doesn't need it.

If your interfaces define their own contracts and your implementations point back to them, the AI doesn't need a retrieval system to find architectural intent. It's already in the file the AI is editing. The same documentation that helps a human reader understand a contract helps the model honor it. No infrastructure required.

This is the third article in a series arguing that most of what AI tooling vendors are selling can be replaced by writing code and documentation honestly. The first article covered why context belongs next to code. The second covered why precise communication with AI requires the kind of vocabulary only experience produces. This one covers the layer those two articles didn't address: shared rules. Contracts. Anything that applies to more than one file by definition.

The throughline across all three is the same. **Reduce what the AI has to infer.** Inference is where models fail, not because they cannot reason, but because every inference is a coin flip weighted by whatever appeared most often in training data, which is mostly code written by developers who hadn't yet had the breakthroughs that produce good architecture. Every rule a senior engineer would infer correctly is a rule the AI will infer incorrectly often enough to matter. The fix is not to hope the model gets it right. The fix is to write down what would otherwise be inferred, in the place the AI is already looking.

That is what this framework is. A way of capturing hard-won, established engineering rules as documentation the AI can read at the moment it needs them. Globals in config. Contracts on interfaces. Mechanics in implementations. Nothing left to inference that a senior engineer would have written down for a junior teammate.

## Why AI defaults to bad architectural patterns

A junior developer looks at an interface with a single implementation and sees ceremony. Why the abstraction? Why the indirection? Why split the contract from the mechanics when one file would do? They are not wrong to ask. They are missing the answer, which they cannot have yet, because the answer is on the other side of an experience they have not had.

The experience is a migration. Or a rewrite. Or an incident at 3am where a tightly coupled module took down three services that should have been independent. The recognition that follows, the moment a developer understands *why* the patterns exist because they have lived through their absence, is what I called anagnorisis in [a previous article](https://www.linkedin.com/pulse/ai-development-communication-problem-always-william-dunn-j620e/). It cannot be taught. It has to be experienced. And it is the dividing line between developers who reach for interfaces by default and developers who see interfaces as bloat.

AI sits on the wrong side of that line.

The training corpus for these models is overwhelmingly code written by developers who haven't yet had the breakthrough, simply because that's the statistical majority of public code. Models default to direct instantiation, recreated abstractions, business rules duplicated across implementations, and tightly coupled modules. Not because they cannot reason about architecture, modern frontier models can, when given the context. They default that way because it's the center of mass in what they learned from.

This means the burden of *enforcing* the contract layer falls on the human. And the cheapest place to enforce it is in the code itself, before the AI ever generates anything.

## The failure modes this addresses

Three patterns show up consistently when AI is left to infer architectural intent on its own.

**Recreated abstractions.** The model writes a helper, a validator, a mapper, a result type that already exists somewhere in the codebase. It cannot see what it cannot see, and the existing abstraction was three files away from the current context. So it makes a new one. Multiplied across a codebase, this is how you end up with four implementations of the same idea, none of which know about each other.

**Ignored interface contracts.** The interface says implementations must be idempotent. The new implementation is not. The interface said so in a design doc that lives in Confluence, or in a code review comment from eighteen months ago, or in the head of the engineer who wrote the original implementation. None of those are visible to the AI when it generates the new one.

**Inconsistent implementations of the same pattern.** Three implementations of the same interface, three different approaches to error handling, three different logging conventions, three different ways of expressing the same business rule. Each looks reasonable in isolation. Together they are unmaintainable.

All three failures share a root cause: the rules that should constrain implementations are not written down where the AI can see them at the moment it needs them.

## The hierarchy

Rules belong at the layer they apply to. Globals in config files, contracts on interfaces, mechanics in implementations. Pointers go up. Duplication does not happen.

This is not new computer science. It is separation of concerns applied to documentation. The contribution is being explicit about the placement, because placement is exactly the kind of decision the AI will infer if you let it, and inference is where this all goes wrong.

- **Global rules** live in `CLAUDE.md`, `AGENTS.md`, and `.cursor/rules`. These are the rules that apply everywhere: documentation requirements, naming conventions, project-wide constraints. They were established in the first article in this series.
- **Contract rules** live on the interface or base class. These are the rules every implementation must honor: idempotency requirements, ordering guarantees, side effects, what callers are entitled to assume.
- **Implementation rules** live on the implementing type. These are the rules specific to this code: which SDK version, which retry policy, which configuration knobs, which extensions are permitted and which are not.

Each layer references up. An implementation points to its contract. A contract points to the global rules file. Nothing is repeated. If a rule changes, it changes in one place, and every reader, human or model, sees the new rule the next time they follow the pointer.

## The examples

The interface defines the contract once:

```csharp
/// <summary>
/// Contract for processing payments against the ledger.
/// </summary>
/// <remarks>
/// Global Rules: CLAUDE.md, AGENTS.md, .cursor/rules
///
/// Contract Rules:
/// - Implementations must be idempotent
/// - Must reject stale account balances
/// - Must emit a LedgerEvent on success
///
/// Implementations:
/// - Services/Payments/StripePaymentProcessor.cs
/// - Services/Payments/AchPaymentProcessor.cs
///
/// Do Not:
/// - Add methods that bypass validation
/// - Allow implementations to swallow exceptions
/// </remarks>
public interface IPaymentProcessor
{
    Task<Result> ProcessPaymentAsync(PaymentRequest request);
}
```

The implementation points back to the contract and documents only what is specific to it:

```csharp
/// <summary>
/// Stripe-backed implementation of IPaymentProcessor.
/// </summary>
/// <remarks>
/// Contract: Services/Payments/IPaymentProcessor.cs
///
/// Implementation Notes:
/// - Idempotency enforced via Stripe-Idempotency-Key header
/// - Retries handled by Polly policy registered in DI
/// - Accepts optional metadata dict via params overload for Stripe-specific tags
///
/// Dependencies:
/// - Services/Payments/IPaymentProcessor.cs
/// - Infrastructure/Stripe/StripeClient.cs
/// - Data/LedgerRepository.cs
///
/// Do Not:
/// - Move retry logic into this class
/// - Use the metadata overload for ledger-relevant data
/// </remarks>
public class StripePaymentProcessor : IPaymentProcessor
```

When the AI opens the implementation to make a change, it sees the `Contract:` pointer immediately. If the change touches the contract's rules, it has the path. If the change is purely about Stripe mechanics, the implementation file already tells it what it needs to know. The metadata overload is a Stripe-specific extension that doesn't belong on the interface, every other implementation would have to ignore it. It belongs here, with a `Do Not` clarifying that it shouldn't leak into ledger logic.

The pattern is the same in TypeScript, Python, or any language with structured documentation. The format is whatever the language and tooling already support. The discipline is what matters.

## The CLAUDE.md and AGENTS.md additions

The first article in this series established the global rules file. This adds one section to it.

```markdown
# Documentation hierarchy

Rules live at the layer they apply to. Never duplicate across layers.

- Global rules: this file, AGENTS.md, .cursor/rules
- Contract rules: on the interface or base class
- Implementation rules: on the implementing type

When documenting an interface or base class:
- Reference global rules with: "Global Rules: CLAUDE.md, AGENTS.md, .cursor/rules"
- Define Contract Rules that every implementation must honor
- List known Implementations by relative path
- Use Do Not for what implementations are forbidden from doing

When documenting an implementation:
- Reference the contract with: "Contract: <relative path>"
- Document only what is specific to this implementation
- Do not restate Contract Rules
- Use Do Not for what this specific code must not do

Before editing an implementation, read its Contract first.
Before editing a contract, list its Implementations and check them.
```

And `AGENTS.md` gets a short addition for contract changes:

```markdown
# Contract changes

When modifying an interface or base class:
1. Read the Implementations list in its @remarks
2. Confirm each listed file exists
3. If a Contract Rule changes, every implementation must be reviewed

If the Implementations list is missing or stale, stop and report.
```

That is the entire enforcement layer. No retrieval system, no vector store, no custom agent. The rules are in the files the AI is already reading.

## The diagnostic

Three signs the structure has collapsed:

If your implementations all repeat the same rules in their headers, your interface isn't doing its job. The contract layer exists specifically so those rules live in one place.

If your interface has no `Implementations:` list, the AI cannot follow the chain when a contract rule changes. Neither can you. Maintain the list.

If global rules appear on contracts, or contract rules appear on implementations, the hierarchy has flattened. Push them back up to where they belong.

These are not exotic failure modes. They are the same failures any documentation discipline produces when it is not maintained. The difference now is that the AI is also a reader, and unlike a human, it will not push back when the structure is wrong. It will silently produce code that conforms to whatever flattened structure it finds.

## The trade

You are choosing layered context over flat duplication. You give up the convenience of seeing every rule in every file. In exchange, you get a documentation structure that mirrors your code structure, which is what good engineering has been building toward for decades.

You also give up the appeal of solving this with infrastructure. There is no dashboard. No vector store. No procurement cycle. Just a discipline applied consistently in the files you are already writing.

This is the pattern across the series. Companies are investing in tooling that addresses the symptoms of undisciplined codebases. The tooling is not useless. But the cheapest, most durable fix is almost always upstream, in the code itself, applied early enough that the symptoms never arise. Context next to code. Vocabulary built through experience. Contracts defined where they belong.

Each of these is doing the same job: reducing what the AI has to infer. The framework is a written record of what a senior engineer would have known without being told. Once it is written, the AI does not need to be a senior engineer to behave like one. It just needs to read what is already in front of it.

None of this is new computer science. It is old computer science, applied honestly, in a context where shortcuts get expensive faster than they used to.
