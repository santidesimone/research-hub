# UI redesign: navigation, reading view, questions, thoughts, graph filters

Status: **proposed, not approved.** Nothing here is built. Once approved it becomes Task 11 in `BUILD_BRIEF.md`.
Books come right after this ships; this design already leaves their place (Reading group, covers, chapters).
Clickable mockup: https://claude.ai/artifact/7nK8Z1kCjeZeP2JKUBC15H (sample data).

## What is wrong today

1. **The Library bar puts every kind of thing in one row:** collections, a view (Graph), two maintenance tools (Audit,
   Curation) and a "More" menu with more mixed entries. It grows with every type.
2. **"Audit" and "Curation" are jargon** for one job: checking and fixing the graph.
3. **The graph legend is a row of chips,** always visible, with no all/none.
4. **Questions and hypotheses are hard to navigate.** A first draft of this proposal put them in one indented tree,
   mixing your questions, sub-questions, hypotheses and questions extracted from papers. That was confusing.
5. **Notes and projects don't fit.** Notes are Markdown files synced from a folder (a git repo), which is clumsy, and
   projects add a layer the hub doesn't need: it is for research and knowledge, not for managing work.

## Principles

- **One browsing pattern everywhere:** a list on the left and the selected item's page on the right. This is today's
  Papers view, which works, applied to every collection and to questions and thoughts.
- **Group by purpose, not by type.** Each type declares its group in `schema/schema.json` (architecture rule 2), so a
  new type (Books) lands in the right place without UI changes.
- **Controls appear when needed:** the graph filter is a panel you open, and the sidebar can be hidden for reading room.
- **Rough thoughts become structure.** A quick thought is a starting point; the hub helps turn it into a typed item.
- **No rows of chips.** Choices live behind a button that opens a roomy popover (one option per line, with a short
  explanation), which closes with Esc or a tap outside. Statuses and counts are plain text, not pills.
- **Room to breathe.** List entries get generous padding and line height; long titles wrap to three lines.
- No framework, no build step, no new dependency. Same shell/app/skin split.

## 1. Navigation: a sidebar of groups

The Library's top row is replaced by a left sidebar that can be collapsed to a thin rail («/»). On a phone it is a
drawer behind ☰.

| Entry | Holds |
|---|---|
| **Thoughts** (top, with an open count) | Quick thoughts waiting to be turned into something (section 4). |
| **Reading** | Papers, Books (next). |
| **Knowledge** | Methods, Frameworks, Ontologies, Use cases, Case studies. |
| **Inquiry** | Questions, Hypotheses. |
| Graph, Review (apart, at the bottom) | Tools, not collections. Review is owner-only, with a waiting count. |

- **"All"** becomes the "Search everything" box at the top of the sidebar.
- The top bar keeps only the app links: no + Thought button and no Owner badge. Thoughts are added from the Thoughts
  list (+ New) or at the end of any item page.
- **Schema change (additive):** each type gets `"ui_section"`; the schema gets a `ui_sections` list (id, label,
  order). It replaces `ui_more` and `ui_group`.
- **Addresses stay** (`/library/papers?key=…`, `/library/graph`). `/library/audit` and `/library/curation` redirect to
  `/library/review`; `/library/questions`, `/library/hypotheses` and `/library/thoughts` are new.

## 2. Reading view for papers and books (and every other collection)

Every collection uses today's Papers layout. There are no full-width title rows.

- **Left, 340 px:** search, + New, sort, status filter, count; then entries with the title (up to three lines),
  authors · year, and status · venue as plain text. Books show a small cover.
- **Right:** the item page as today: kicker (type · kind · year), title, authors, status, Read PDF / Source / Edit,
  and the tabs **Info**, **Analysis**, **Connections** and **Reader**. Text width is capped (about 800 px).
- **Books** add chapters: a thought or finding can point to a chapter. The rest of the Book model is designed after
  this ships.
- **Analysis** shows the paper's own stated question as text (section 3).
- **Connections** (new tab, with a count) is the one place to see and manage everything an item is linked to:
  - a simple diagram: the item on the left, a line out to each group (Questions, Hypotheses, Methods, Frameworks,
    Concepts, Papers and books…), and each link as a row with its role in colour (green agrees, red disagrees, blue
    neutral), the linked item and its note;
  - clicking a row opens that item; **⋯** on a row opens a small menu: change how it relates, add or edit a note,
    unlink;
  - **Link…** opens a picker over everything in the library (any type, grouped, with search), then asks how it
    relates, offering only the roles the schema allows for that pair;
  - **Suggested by Claude:** links Claude proposes, each with a reason, and Link / Dismiss.
- **Your thoughts on this:** each item page ends with its thoughts and a one-line field to add one.
- Methods, frameworks and the other knowledge types use the same two panes, without the reading-only bits (status,
  Read PDF, Reader).

## 3. Questions and hypotheses: your own, informed by sources

Questions and hypotheses are **yours and stand on their own**. You (or Claude, when you ask) create them; papers and
books are then *linked* to them because they are relevant. A paper never creates one by being analysed.

**Model (additive):**
- **Links are generic.** The Link picker and the Connections tab work over every type and relation in
  `schema/schema.json`, so new types (Books) and relations appear without UI changes.
- A hypothesis may answer **zero or more** questions (`ANSWERS`, many-to-many). One with no question is fine.
- **`INFORMS`** (new): Paper, Book, Method, Case study or Framework → Question or Hypothesis, with optional `role`
  (`background`, `supports`, `challenges`), `note` (why it matters) and `location`. It is the everyday link.
- **`TESTS`** (kept): Paper → Hypothesis with a `result`. It is the strong form, a paper that tested it, and the only
  input to the hypothesis status.
- `ADDRESSED_BY` and `ASKED_IN` become `INFORMS` (a migration copies them, deleting nothing).
- **A paper's own research question becomes a text field on the paper** (`stated_question`, shown in Analysis), not a
  Question node. Claude's paper analysis stops creating questions and hypotheses. It **matches the paper against your
  existing questions and hypotheses** and proposes `INFORMS` and `TESTS` links instead ("Claude thinks it may also
  inform …", one click to link).
- Existing extracted questions (`origin: extracted`) are folded in by a migration: their text is copied into the
  paper's `stated_question`, then a curation plan proposes deleting the nodes, for you to review. `origin` stays only
  as provenance and is never shown.

**UI.** The Inquiry group has two entries, **Questions** and **Hypotheses**, each with the usual list and page.
- **Question page:**
  - the question, status and broader question;
  - **Hypotheses** as compact cards: statement, verdict badge, and one line like "3 papers tested it: 2 support it,
    1 mixed". A card opens the hypothesis page;
  - narrower questions;
  - **Sources that inform it**, each with its note, and **Link…** (the same picker).
- **Hypothesis page:**
  - the statement, verdict and evidence bar;
  - **Papers that tested it** (result and where);
  - **Other relevant sources** (role and note);
  - **Questions it answers** (can be none), with **Link…**;
  - variables.
- **Paper (and book) page:** the Connections tab (section 2) shows and manages these links.
- Verdicts are written as text ("Supported. 3 papers tested it: 2 support it, 1 mixed."), not as badges.
- **Projects are removed** (section 7).

## 4. Thoughts: from a rough idea to structure

Replaces Notes. A thought is a short text, stored in the database (no files, no GitHub, no sync step), optionally
attached to what you were looking at: a paper, a book (chapter), a question or a hypothesis.

- **Capture:** + New in the Thoughts list, the field at the end of any item page, or Claude in the chat ("note this
  thought on the SoK paper: …", an MCP tool `add_thought`).
- **Thoughts inbox:** the list shows waiting thoughts, each with what it is on and when. A thought's page shows
  Claude's suggestion with one button (**Turn into a hypothesis**), and **Something else…** opens a popover with the
  other choices, each explained:
  - a question;
  - a hypothesis (answering one of your questions);
  - a critique of the paper (a `CRITIQUES` link carrying the text);
  - supports or contradicts a paper;
  - a finding;
  - a method;
  - or keep it as a note.
- **Claude suggests the type.** It reads the thought and the item it is on, and pre-selects the closest type with a
  one-line reason; you confirm, and can edit the fields before saving. In the chat the same flow is one request:
  "turn my open thoughts into proper items", which proposes them for your OK.
- **Afterwards:** the hub offers **Delete the thought** (one click, never automatic) or **Keep it**. The new item
  carries the usual provenance (`by` / `at` / `model` / `confidence` / `status`).
- **Existing Markdown notes:** a one-time import brings them in as thoughts (kept "as a note" if they are long).
  `hub sync-notes` is then retired. That needs a migration that copies first and deletes nothing.

## 5. Review: Audit and Curation in one place

One owner-only entry, **Review**, with two tabs: **Check Claude's work** (today's Audit buckets with Accept/Edit) and
**Proposed fixes** (today's curation plans with Apply/Reject/Undo). The API, MCP tools and plan log are unchanged.

## 6. Graph: a filter panel instead of chips

- A slim toolbar: **Filter**, **Fit**, and a summary ("Showing 12 of 16 types · 24 nodes").
- **Filter** opens a panel (a bottom sheet on a phone):
  - a type search;
  - All / None, globally and per group;
  - checkboxes grouped like the sidebar, plus **Vocabulary** (topics, domains, concepts, people, organisations,
    venues), each with a colour dot and a count.
- **Default:** everything on except the large vocabulary (concepts, people, organisations, venues). The choice is
  remembered per browser (localStorage, wrapped in try/catch).
- Clicking a node keeps today's behaviour.

## 7. Projects are removed

Projects (`Project` nodes, from the Markdown `projects/` folder) organise work, which the hub is not for. The type is
removed from the schema, UI, MCP and CLI. Before that, a check lists any Project nodes in production; if there are
none, they simply go; if there are some, a curation plan proposes deleting them for you to review.

## 8. Out of scope here

- The Book type itself (fields, chapters, ISBN lookup): next, after this ships.
- Skins and colours: the tokens stay; only the structure changes.
- Home, Query and Settings apps.

## Build plan (after approval), one commit each

1. **Schema `ui_section` and the sidebar** (collapsible, a drawer on phones), with redirects for the old addresses.
2. **The two-pane reading view** for every collection, with "Your thoughts on this" (it shows nothing until step 4).
3. **Review** (the Audit and Curation tabs) and the **graph filter panel**.
4. **Thoughts:**
   - the type (database-managed), `add_thought` over MCP and the API;
   - the inbox and the Turn it into flow, with Claude's suggestion;
   - the import of existing notes;
   - retiring `sync-notes`.
5. **Questions and hypotheses:**
   - the `INFORMS` link and many-to-many `ANSWERS`;
   - `stated_question` on papers, and the migration of extracted questions;
   - the two lists and pages;
   - Claude's paper analysis matching against your questions instead of creating them;
   - removing Projects.
6. Each step gets:
   - offline tests (grouping is schema-driven; routes; the hypothesis status and evidence tally; the thought-to-item
     transform with provenance);
   - Playwright checks on desktop and phone width with no console or CSP errors;
   - updates to the existing browser suites;
   - README and PROGRESS updated.

   Then deploy.

## Decisions taken

- Use cases and Case studies stay under Knowledge.
- A thought turned into an item is deleted on one click, never automatically.
- Projects are removed (section 7).
- Questions and hypotheses are standalone; sources inform them (section 3).
