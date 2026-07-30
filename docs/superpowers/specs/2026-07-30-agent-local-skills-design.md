# HomeAgent Agent Local Skills

**Date:** 2026-07-30

**Status:** Approved design

**Reference:** Mew platform preset `mew` Skill and the existing HomeAgent Agent workbench

## 1. Context

HomeAgent already lets an administrator enter Skill names on an Agent. Those
names are normalized and added to research-task prompts using the selected
provider's invocation syntax. This is not yet a trustworthy Skill lifecycle:

- the UI accepts free text without proving that the Skill is installed;
- the Agent does not bind to an exact local Skill source;
- duplicate names and provider compatibility are not visible;
- ordinary Agent calls do not receive the configured Skills;
- task history does not record which Skills were resolved or skipped.

The Mew Skill describes a much broader platform, including runtime sharing,
source import, daemon management, Issues, Chats, Devices, Automations, and other
resources. HomeAgent will not reproduce that platform in this project. This
design adopts only the smallest useful local Skill lifecycle that strengthens
HomeAgent's current product model.

## 2. Goals

1. Discover Skills already installed for Codex, Claude, TRAE, and the shared
   `~/.agents/skills` location.
2. Bind Skills to an Agent using stable local-source identities.
3. Preserve the existing relationship:

   ```text
   Feishu chat -> space -> Agent -> Skill bindings
   ```

4. Apply the bound Skills to every Agent call in that space, while preserving
   operation-specific permission limits.
5. Make provider compatibility, duplicate sources, invalid files, and runtime
   skips visible and truthful.
6. Record reproducible Skill evidence for durable research-task runs.
7. Migrate existing string-based Agent Skill configuration without silently
   choosing an ambiguous source.

## 3. Non-goals

The first release does not add:

- Git, URL, package, or install-command Skill import;
- automatic source updates;
- a standalone Skills page;
- a persisted workspace Skill registry;
- filesystem watchers;
- Mew daemon, runtime sharing, remote Devices, or multi-machine execution;
- Mew Issues, canonical Chats, Messages, general Runs, Automations, Labels,
  Files, Notifications, or authentication APIs;
- extra write permission for ordinary Agent calls;
- a claim that HomeAgent can prove a model semantically followed a Skill.

Git and URL import may be added later on top of the local catalog, but it is not
part of this implementation plan.

## 4. Product Model

### 4.1 Binding hierarchy

A Feishu group never binds directly to a Skill. The existing Feishu binding
selects a team space, the space selects an Agent, and the Agent owns the Skill
bindings:

```text
Feishu group A
  -> team/oc_a
    -> Agent A
      -> Skill bindings A

Feishu group B
  -> team/oc_b
    -> Agent B
      -> Skill bindings B
```

Personal spaces use the same model:

```text
personal/<open_id> -> Personal Agent -> Skill bindings
```

Changing a space's Agent affects new calls immediately. A research-task run
keeps the Agent and Skill-resolution snapshot captured at start, so later
configuration changes cannot rewrite history.

### 4.2 Permission hierarchy

Skill selection and execution permission are separate:

- group chat, ask, dream, and learning calls use the bound Agent and Skills with
  a fixed read-only execution policy;
- research tasks use the same Agent Skills together with the Agent's configured
  Permission and Workdir;
- a Skill binding never upgrades an operation from read-only to write or full;
- a space without a bound Agent keeps the existing default-provider behavior
  and receives no additional Skills.

Skills therefore belong under **Agent capabilities** in the UI. Permission and
Workdir remain under **Task execution**.

## 5. Architecture

### 5.1 `SkillCatalog`

Add a core service that projects local files into a read-only catalog. It is
responsible for:

- enumerating configured Skill roots;
- locating bounded `SKILL.md` files;
- parsing safe metadata;
- computing `SKILL.md` hashes;
- identifying provider compatibility;
- grouping identical content for display;
- reporting same-name conflicts and invalid sources;
- resolving an Agent binding immediately before execution.

The catalog does not copy Skill content into Agent configuration, execute Skill
scripts, install dependencies, or persist a second source of truth.

### 5.2 Provider adapters

Extend the existing provider boundary with explicit Skill behavior per provider:

- discovery roots;
- provider-compatible invocation name;
- invocation syntax such as `$name`, `/name`, or the provider's plain form;
- diagnostics when a selected source is unsupported or shadowed.

The adapter returns a resolution result rather than interpolating unchecked
Agent strings directly into a prompt.

### 5.3 Execution resolver

All Agent-backed flows call one resolver after selecting the space's Agent. The
resolver produces:

```ts
interface ResolvedAgentSkills {
  requested: SkillRequestSnapshot[];
  resolved: ResolvedSkillSnapshot[];
  skipped: SkippedSkillSnapshot[];
  warnings: string[];
}
```

The caller passes only `resolved` invocation names to the provider. It uses
`warnings` for user-visible output and durable task evidence.

### 5.4 Durable run evidence

Research-task runs persist the Skill resolution captured at run start:

- requested binding identity and display name;
- resolved provider invocation name;
- actual source identity used;
- `SKILL.md` hash at execution time;
- skipped binding identity and diagnostic reason.

This snapshot is evidence that HomeAgent found a compatible local source and
requested that the provider load it. It is not evidence that the model
semantically obeyed the Skill.

## 6. Data Model

### 6.1 Catalog source

Each actual installation is represented independently:

```ts
interface SkillSource {
  sourceKey: string;
  name: string;
  description: string;
  providerIds: ProviderId[];
  skillFile: string;
  skillFileHash: string;
  status: "available" | "invalid";
  diagnostics: string[];
}
```

`sourceKey` is derived from a known root kind and the normalized relative Skill
directory. It must not contain an unbounded user-controlled absolute path.
Content changes at the same source keep the same `sourceKey`. `skillFileHash`
is the SHA-256 digest of the raw `SKILL.md` bytes. It identifies the instruction
file used for display grouping and run evidence; it does not claim that
supporting scripts or assets in two source directories are identical.

### 6.2 Agent binding

An Agent stores either a selected source identity or an unresolved legacy name:

```ts
interface SourceSkillBinding {
  kind: "source";
  sourceKey: string;
  name: string;
}

interface LegacySkillBinding {
  kind: "legacy-name";
  name: string;
}

type AgentSkillBinding = SourceSkillBinding | LegacySkillBinding;
```

The `name` supports readable warnings if the source later disappears.
`legacy-name` is written only by migration and remains until an administrator
chooses or removes a source. Runtime invocation names always come from a fresh
resolution, not from either name snapshot.

### 6.3 Existing configuration migration

Older Agent records contain `skills: string[]`.

For each old name:

1. If the current Agent provider has exactly one compatible catalog match,
   migrate it to that source.
2. If there is no match, retain it as an unresolved legacy binding.
3. If multiple matches have different `SKILL.md` content, retain it as an unresolved
   ambiguous binding.
4. Show unresolved bindings in the Agent UI with a warning and allow the
   administrator to choose a source or remove the binding.
5. Skip unresolved bindings at execution and report them according to the
   warning policy.

Migration must never silently use provider directory precedence to select one
of multiple Skills whose `SKILL.md` content differs.

The persisted Agent schema should gain an explicit version or an equally clear
discriminator so string and source-bound records cannot be confused.

## 7. Discovery and Resolution

### 7.1 Roots

The catalog scans provider-native roots and the shared root:

- Codex user, plugin-cache, and vendor-import Skill roots;
- Claude user, plugin-cache, and marketplace Skill roots;
- TRAE CLI Skill roots;
- `~/.agents/skills`.

The exact root list and precedence live behind provider adapters and are covered
by tests. The first release scans known default roots only and does not add a
new root-override setting. Shared Skills are compatible with all three providers
unless the provider adapter reports otherwise. The catalog must not change
provider homes, authentication paths, or process-wide configuration to make a
Skill appear installed.

### 7.2 Scan safety

Discovery:

- reads `SKILL.md` only;
- does not execute scripts, imports, hooks, or install commands;
- does not follow directory symlinks;
- deduplicates roots by resolved real path;
- rejects files larger than a bounded limit;
- bounds directory depth, visited entries, discovered Skills, and total bytes;
- treats unreadable files and parse errors as catalog diagnostics rather than
  application startup failures;
- never logs Skill bodies.

The parser reads only the frontmatter fields required for the catalog. Missing
or invalid names make a source visible but unavailable for selection.

### 7.3 Duplicate and conflict rules

- Same normalized name and same `SKILL.md` hash: display one catalog row with all
  sources listed.
- Same normalized name and different `SKILL.md` hash: display separate variants
  with explicit source labels.
- Agent bindings still point to an actual `sourceKey`, even when identical
  sources are visually grouped. Selecting a grouped row chooses the
  provider-effective source according to the adapter's documented precedence
  and shows that source before save; the administrator may expand the row and
  choose another invocable source.
- Provider adapters identify sources that are compatible but shadowed by a
  provider's native resolution rules. Shadowed sources remain visible and
  diagnostic; HomeAgent must not claim it can invoke an exact source if the
  provider cannot do so.

### 7.4 Cache and refresh

A full catalog scan is cached briefly in memory. It is refreshed:

- when the cache is stale and an Agent management page needs catalog data;
- when the administrator presses **Refresh**;
- after the application starts and the first catalog consumer requests data.

Every Agent execution directly rechecks only its bound Skill files and provider
resolution. It must not recursively scan every plugin root for every Feishu
message.

## 8. Execution Flow

Each Agent-backed operation follows this sequence:

```text
resolve inbound space
  -> resolve bound Agent
  -> resolve Agent Skill bindings
  -> partition resolved and skipped Skills
  -> construct operation-specific provider execution policy
  -> request provider Skill loading
  -> execute the existing Agent prompt
  -> expose warnings and persist task evidence
```

### 8.1 Ordinary Agent calls

Group chat, ask, dream, and learning:

- use the space's bound Agent and Skill bindings;
- force a read-only execution policy;
- do not inherit Agent `write` or `full`;
- append one bounded warning block when any Skill was skipped;
- do not expose absolute paths in the reply.

### 8.2 Research tasks

Research tasks:

- resolve Skills before starting the provider process;
- use the Agent's Permission and Workdir;
- persist the resolution snapshot with the run;
- remain successful when the provider succeeds but one or more Skills were
  skipped;
- include a bounded Skill warning in task details and completion notification.

### 8.3 Skip policy

The user selected graceful degradation:

- missing, unreadable, invalid, incompatible, ambiguous, or shadowed Skills are
  skipped;
- other resolved Skills still load;
- the base Agent still runs if every Skill is skipped;
- the user sees a concise warning naming each skipped Skill and its category;
- detailed paths and parser diagnostics remain in the administrator UI.

Provider process failures keep their existing status and error handling. They
must not be rewritten as Skill-resolution failures.

## 9. Truthful Status Language

HomeAgent can prove:

- a selected local source existed at resolution time;
- its `SKILL.md` passed bounded parsing;
- the source was compatible with the selected provider;
- HomeAgent added the provider invocation request;
- the provider process succeeded or failed.

HomeAgent cannot currently prove that a model semantically followed the Skill.
UI and task history therefore use language such as:

- **Resolved and requested**
- **Skipped**
- **Unavailable**
- **Provider process succeeded**

They must not use **confirmed loaded** or **Skill executed successfully** unless
a future provider supplies machine-verifiable evidence.

## 10. Agent Workbench

### 10.1 Placement

Move Skills out of the collapsible Task execution fields and add an
**Agent capabilities / Skills** section.

The existing Permission and Workdir controls remain under Task execution with
copy explaining that they apply only to research tasks.

### 10.2 Inline selector

The first release uses an inline searchable multi-selector:

- search by Skill name and description;
- provider badges;
- source label with the home directory abbreviated to `~/`;
- selected Skill chips;
- identical-source grouping;
- separate rows when same-name `SKILL.md` content differs;
- manual **Refresh**;
- expandable source and diagnostic details.

It does not add a standalone Skills navigation item or page.

### 10.3 UI states

**Empty catalog**

- list the classes of directories that were scanned;
- explain that no installed Skills were found;
- provide Refresh;
- do not fall back to an unchecked free-text field.

**Invalid source**

- show the Skill directory and bounded diagnostic;
- disable selection.

**Legacy unresolved binding**

- retain it as a warning chip;
- allow source selection or removal;
- never auto-select an ambiguous variant.

**Provider change**

- preserve Agent bindings;
- recalculate badges and compatibility;
- allow saving incompatible bindings because the runtime policy is skip and
  warn;
- show a clear pre-save warning.

**Bound spaces**

- keep the existing inspector's space and Feishu-group bindings visible;
- show aggregate compatibility for the Agent's current provider.

## 11. Web and Service Boundaries

Agent pages receive catalog view data from the core service. Refresh is an
explicit local administration action that invalidates the catalog cache and
redirects back to the selected Agent.

Agent create and update forms submit source binding identifiers, not arbitrary
paths or Skill bodies. The server validates submitted bindings against the
current catalog but preserves already-stored missing bindings so an unrelated
Agent edit does not silently delete configuration.

This release does not expose a Mew-compatible Skill API or a general remote
management endpoint.

## 12. Security and Privacy

- Discovery is read-only and non-executing.
- Submitted source keys must resolve under a known Skill root.
- Absolute local paths are restricted to authenticated local administration
  views and displayed with home-directory abbreviation.
- Feishu warnings contain Skill names and bounded reason categories only.
- Skill bodies, credentials, provider configuration, and private paths are not
  logged or returned to Feishu.
- Ordinary calls remain read-only even when an Agent has task `write` or `full`.
- Catalog refresh must not block application startup or the Feishu event loop.
- Malformed or hostile local Skill metadata is treated as untrusted text and
  safely escaped in HTML, logs, warnings, and prompts.

## 13. Testing

### 13.1 Catalog unit tests

Use temporary roots to cover:

- every supported provider and shared root;
- valid frontmatter;
- missing or invalid names;
- oversized and unreadable files;
- duplicate roots;
- identical-content grouping;
- same-name, different-`SKILL.md` conflicts;
- directory symlinks and traversal attempts;
- depth, entry, Skill-count, and byte limits;
- stable source keys across content edits;
- cache refresh and direct bound-source recheck.

### 13.2 Agent-store tests

Cover:

- exact source binding persistence;
- unique legacy-name migration;
- missing legacy names;
- ambiguous legacy names;
- provider switching;
- preservation of missing bindings during unrelated edits;
- safe schema-version migration and restart.

### 13.3 Provider and execution tests

Cover:

- provider-specific invocation syntax;
- resolved-versus-skipped partitioning;
- same-name shadow diagnostics;
- read-only policy for chat, ask, dream, and learning;
- Agent Permission and Workdir for research tasks;
- partial and total Skill unavailability;
- warning bounding and path redaction;
- unchanged behavior when no Agent or no Skills are configured.

### 13.4 Orchestrator and binding tests

Prove the full relationship:

```text
Feishu group A -> space A -> Agent A -> Skills A
Feishu group B -> space B -> Agent B -> Skills B
```

Also cover personal spaces, Agent rebinding, and group messages received after a
provider or Skill source becomes unavailable.

### 13.5 Task-run tests

Cover:

- requested, resolved, and skipped snapshots;
- `SKILL.md` hash captured at run start;
- successful runs with Skill warnings;
- failed provider runs retaining Skill evidence;
- restart persistence;
- compatibility with older task-run files;
- notification copy for warnings.

### 13.6 Web tests

Cover:

- searchable inline selector;
- selected chips;
- empty, invalid, conflict, legacy, and incompatible states;
- provider badge updates;
- Refresh redirect;
- safe HTML escaping;
- create, edit, validation, and responsive layouts.

The full test suite and TypeScript check must pass.

## 14. Acceptance Criteria

The first release is complete when:

1. HomeAgent discovers bounded local Skills from all approved roots without
   executing local Skill code.
2. An Agent binds to explicit local Skill sources through the inline selector.
3. Different Feishu groups can use different Agent Skill sets through their
   existing space bindings.
4. Every Agent-backed flow requests the Agent's resolved Skills.
5. Ordinary calls remain read-only; research tasks preserve Agent task
   Permission and Workdir.
6. Missing or incompatible Skills are skipped, the base Agent continues, and
   the user receives a bounded warning.
7. Research-task history persists requested, resolved, and skipped Skill
   evidence with `SKILL.md` hashes.
8. Duplicate, conflicting, invalid, legacy, and provider-incompatible states are
   represented truthfully.
9. Existing installations with string Skill names migrate without silently
   selecting an ambiguous source.
10. Existing behavior is unchanged when an Agent has no Skill bindings.
11. No standalone Skills page, Git/URL import, daemon, remote Device, or Mew
    platform resource subsystem is introduced.

## 15. Future Extension

Git or URL import can later add a managed source repository behind the same
`SkillCatalog` and `AgentSkillBinding` contracts. That future work must define
trust confirmation, revision pinning, update policy, installation location, and
rollback before it is implemented. It does not change the group-to-space-to-
Agent binding model established here.
