# Metadata schema design (v1, approved with recommended defaults)

Four collections: **Paper, Method, Use case, Case study**. Existing types **Note** and **Project** stay as related content (graph nodes and "related items"), with no collection of their own.

Legend. *By*: **S** source (Crossref/OpenAlex/the file), **C** Claude, **Y** the owner, **Sys** the hub. *Tier*: **Core** always filled, **Standard** filled on every Claude analysis, **Deep** only on request.

## Principles

1. Separate what a source says from what is inferred. Facts come from sources, content analysis from Claude, judgement from the owner. Each field records which.
2. **Claude saves directly. There is no approval step.** Every Claude-written field records `by=claude`, model, date and confidence. Review is an optional audit and never blocks use. Safety rules: **empty beats wrong** (leave a field empty rather than guess), and every finding must carry a location in the source.
3. Three tiers per type keep the schema rich but cheap to fill.
4. Structured where you query (enum, number, date, link), free text where you read.
5. Controlled vocabularies are shared nodes, not strings. The **server** matches names to existing nodes, so Claude never looks them up.
6. Additive evolution. New fields are optional. Renames and removals go through numbered migrations.
7. Design from the questions backward (competency questions below). A field that answers no question is cut.

## Fields common to every item

| Field | Type | By | Tier |
|---|---|---|---|
| key | text, unique (`doi:...`, `method:slug`, `usecase:slug`, `case:slug`) | Sys | Core |
| collection | enum paper, method, use_case, case_study | Sys | Core |
| title | text | S/C/Y | Core |
| tldr | text, one sentence | C | Core |
| summary | text | C | Standard |
| body | markdown (owner's long notes) | Y | Standard |
| topics | links to Topic | C/Y | Standard |
| tags | text list | Y | Standard |
| visibility | enum private, public | Y | Core |
| record_status | enum auto, reviewed | Sys/Y | Core |
| schema_version | integer, per type | Sys | Core |
| provenance | map field -> {by, at, model, confidence, status auto/reviewed} | Sys | Core |
| created_at, updated_at | datetime | Sys | Core |

Reading status and priority stay in the existing personal layer (`Personal -[:FOR]-> Artifact`), never on the item.

## Paper

A. Bibliographic (sources)
| Field | Type | By | Tier |
|---|---|---|---|
| authors | ordered links to Person (name, ORCID) | S | Core |
| year, date | integer, date | S | Core |
| venue | link to Venue | S | Core |
| item_type | enum journal_article, conference_paper, preprint, thesis, report, book_chapter, standard, talk | S | Core |
| doi, arxiv_id, url | text, text, https link | S | Core |
| abstract | text | S | Standard |
| peer_review | enum peer_reviewed, preprint, grey | S/C | Standard |
| open_access | enum gold, green, closed | S | Deep |
| citation_count (+ as-of date) | integer | S | Deep |
| language | text | S | Deep |

B. Methodological classification (Claude)
| Field | Type | By | Tier |
|---|---|---|---|
| contribution_type | enum theoretical, empirical, methodological, system, survey, position, dataset, replication | C | Core |
| research_design | enum experiment, quasi_experiment, observational, survey, simulation, formal_proof, qualitative, case_study, design_science, mixed_methods, desk_review | C | Standard |
| paradigm | enum quantitative, qualitative, mixed, formal | C | Standard |
| domain | link to Domain | C | Standard |
| theoretical_framework | text + links to Concept | C | Deep |

C. Content analysis (Claude, grounded in the text)
| Field | Type | By | Tier |
|---|---|---|---|
| research_problem | text | C | Core |
| main_claim | text | C | Core |
| contributions | list of {text, kind: novel/extension/application} | C | Standard |
| approach | text | C | Standard |
| evidence | {type, source, n, period} | C | Standard |
| analysis_methods | links to Method | C | Standard |
| key_findings | list of {text, location}; location = page or section | C | Standard |
| limitations_stated | list of text | C | Standard |
| limitations_observed | list of text | C/Y | Deep |
| assumptions | list of text | C | Deep |
| threats_to_validity | {internal, external, construct, conclusion} | C | Deep |
| reproducibility | {code_available, data_available, links} | C | Deep |
| implications | {theory, practice} | C | Deep |
| future_work | list of text | C | Deep |
| conflicts_funding | text | C | Deep |

D. Appraisal (owner decides; Claude may fill)
| Field | Type | By | Tier |
|---|---|---|---|
| relevance | integer 1-5 + one-line reason | Y | Standard |
| reading_depth | enum skimmed, read, studied | Y | Standard |
| rigor, novelty | integer 1-5 + reason | Y/C | Deep |
| confidence_in_findings | enum low, medium, high | Y | Deep |

Connections (all optional): INTRODUCES / USES Method, ABOUT Concept/Topic, uses Dataset, typed paper-to-paper relations.

## Method (needs no source paper)

| Field | Type | By | Tier |
|---|---|---|---|
| name, aliases | text, text list | Y/C | Core |
| kind | enum technique, algorithm, protocol, framework, procedure, metric, tool | Y/C | Core |
| purpose | text | C/Y | Core |
| domain | links to Domain | C/Y | Standard |
| level | enum foundational, intermediate, advanced | Y | Standard |
| maturity | enum experimental, established, standard | Y/C | Standard |
| when_to_use, when_not_to_use | text | C/Y | Standard |
| inputs, outputs | text lists | C/Y | Standard |
| procedure | ordered list of steps | C/Y | Standard |
| assumptions | text list | C/Y | Standard |
| strengths, limitations | text lists (incl. failure modes) | C/Y | Standard |
| cost_effort | enum low, medium, high + note | Y | Deep |
| tools_implementations | list of links | Y | Deep |
| example | text | C/Y | Deep |

Connections: VARIANT_OF / REQUIRES / ALTERNATIVE_TO Method; introduced in Paper; supported by Papers; ADDRESSES Use case; USED by Case study.

## Use case (generic, prospective)

| Field | Type | By | Tier |
|---|---|---|---|
| title, tldr | text | Y/C | Core |
| goal | text | Y/C | Core |
| problem_context | text | Y/C | Core |
| domain | links to Domain | Y/C | Core |
| actors | list of {role, organisation_type} | Y/C | Standard |
| preconditions | text list | Y/C | Standard |
| scenario | ordered steps | Y/C | Standard |
| requirements | list of {kind: functional/quality/constraint, text} | Y/C | Standard |
| success_criteria | list of {text, measure} | Y/C | Standard |
| constraints | list of {kind: legal/ethical/technical/economic, text} | Y/C | Standard |
| status | enum idea, candidate, validated, in_use, retired | Y | Standard |
| value | text | Y/C | Deep |
| risks, alternatives | text lists | Y/C | Deep |

Connections: addressed by Methods, evidenced by Case studies/Papers, related Use cases.

## Case study (specific, retrospective)

| Field | Type | By | Tier |
|---|---|---|---|
| title, tldr | text | Y/C | Core |
| case_type | enum deployment, pilot, failure, comparative, historical, research | Y/C | Core |
| organisations | links to Organisation | Y/C | Core |
| sector, geography | link to Domain, text | Y/C | Core |
| sources | list of {url or file link, note} | Y | Core |
| period | {from, to} | Y/C | Standard |
| context, trigger_problem, intervention | text | Y/C | Standard |
| stakeholders | text list | Y/C | Standard |
| timeline | list of {date, event} | Y/C | Standard |
| outcomes | list of {measure, value, direction, expected: bool} | Y/C | Standard |
| lessons | text list | Y/C | Standard |
| evidence_quality | {source_type: primary_data/official_report/academic/journalism/anecdotal, independence: self_reported/independent} | Y/C | Standard |
| sensitivity | enum public, internal, confidential | Y | Standard |
| success_factors, barriers | text lists | Y/C | Deep |
| transferability | text | Y | Deep |

Connections: USES Method, INSTANCE_OF Use case, analysed in Paper.

## Shared vocabulary nodes

Topic (hierarchical: BROADER), Concept, Domain (short owner-maintained list), Person (ORCID), Venue, Organisation, Dataset. Keys `topic:slug`, `concept:slug`, `domain:slug`, `person:...`, `venue:slug`, `org:slug`, `dataset:slug`. Each has `name`, `aliases[]`. Claude passes names; the server normalises (lowercase, strip punctuation, alias match, fulltext fallback) and links to an existing node, or creates one flagged `by=claude`.

Seed Domains (owner can edit): digital currency (CBDC), payments, digital identity, privacy-enhancing technology, cryptography, financial regulation, governance and policy, distributed systems, research methodology, software engineering.

## Typed relations

CITES (Paper->Paper, OpenAlex); BUILDS_ON; CRITIQUES; REPLICATES; CONTRADICTS; SUPPORTS (Paper->Paper, Case study->Use case); INTRODUCES (Paper->Method); USES (Paper/Case study->Method); ADDRESSES (Method->Use case); INSTANCE_OF (Case study->Use case); VARIANT_OF / ALTERNATIVE_TO / REQUIRES (Method->Method); ABOUT (any->Topic/Concept); AUTHORED_BY, PUBLISHED_IN; INVOLVES (Case study->Organisation). Relations may carry `evidence` (short text), `location`, `confidence`, and provenance. Paper-to-paper relations other than CITES are interpretive: Claude saves them with the justifying passage and a confidence; low confidence is flagged in the audit.

## Provenance, evolution and audit

- Provenance per field: `{by: source|claude|owner, at, model, confidence: low|medium|high, status: auto|reviewed}`.
- Owner edits set `by=owner,status=reviewed` and are **never overwritten** by a re-run. A re-run fills only empty fields unless `force` is given, and never touches reviewed or owner values.
- Each type has an integer `schema_version`. Raising it creates a worklist: items with `schema_version` below current. A `schema/CHANGELOG.md` records each change and why.
- New field/type: optional, no migration. Rename/remove: numbered migration that copies data. Unknown fields are preserved. Required (Core) fields are enforced on write; the rest produce warnings.
- Audit view lists: low-confidence fields, empty Core/Standard fields, findings without a location, items below current schema_version, vocabulary nodes created by Claude.

## Competency questions (tests the model must answer)

1. Empirical papers on a topic with a quasi-experimental design and sample size over N.
2. Methods used in case studies in a sector with a positive outcome, and the evidence for each.
3. Papers that contradict or critique the paper I rely on most.
4. Use cases with no addressing method, and with no case study.
5. For a method, the stated limitations across papers that use it.
6. Authors' stated limitations vs my observed ones, for papers I rated highly.
7. Papers with overlapping references that do not cite each other.
8. Items still `auto`, or analysed under an old schema version.
9. Concepts connecting two otherwise separate topics.
10. Lessons from failure case studies, grouped by domain.

## Decisions taken (recommended defaults)

- Claims as their own nodes: **later (v2)**. v1 keeps `key_findings` as a list of `{text, location}`; the model leaves room to promote them.
- Authors as Person nodes: **yes**, ORCID where available.
- Appraisal: **relevance and reading_depth Standard; rigor, novelty, confidence Deep** and optional.
- Use case and Case study: **separate types**.
- Method: the one type that needs no source; Claude drafts from a paper, URL or description.
- Tiers as listed above.
- Notes and Projects: **related content only**, no collection.
- Methods, Use cases and Case studies are **database-managed** (created and edited in the UI, API, MCP, CLI). `hub sync-notes` must skip them and must never prune them. Papers are API-managed. Notes and Projects remain Markdown-managed.
