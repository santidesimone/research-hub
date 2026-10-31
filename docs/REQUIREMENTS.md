# Requirements

Functional requirements (F) and design decisions (D), each with why and status. The model they describe is in
`docs/SCHEMA_DESIGN.md`; the tasks that deliver them are in `docs/BUILD_BRIEF.md`.

> **Earlier requirements are not in this repository.** The addendum `docs/ADDENDUM_frameworks_questions_ontologies.md`
> extends this document starting at F15 and D10, so requirements F1 to F14 and decisions D1 to D9 exist in the owner's
> original requirements document but were never added here. Add them above this section when available; they are not
> reconstructed here, to avoid inventing decisions.

## Frameworks, research questions and hypotheses, ontologies (addendum, Tasks 8 and 8b)

Source: `docs/ADDENDUM_frameworks_questions_ontologies.md`, section 1.

| ID | Requirement | Why | Status |
|---|---|---|---|
| F15 | Store Frameworks (theoretical and conceptual) as their own items, link papers, questions and projects to them. | A paper's lens should be queryable ("every paper using path dependence"), not buried in text | Planned (T8) |
| F16 | Store Research questions and Hypotheses, with the result of each test recorded on the link between a paper and a hypothesis. | One hypothesis can be supported by one paper and contradicted by another; this gives a supported-versus-contradicted view without full Claim nodes | Planned (T8) |
| F17 | Store Ontologies and standards (e.g. FIBO modules, the ISO 20022 data dictionary, ETHON) as descriptive records with pointers to where they live. | These are large, externally maintained, living resources; the hub must reference them, not copy their contents | Planned (T8) |
| D10 | An ontology record stores descriptive metadata and URLs only. The ontology's classes and terms are never imported into the graph. | Avoid flooding the graph and duplicating a maintained source | Planned (T8) |
| D11 | An ontology record may carry an optional snapshot (a frozen copy in the owner's Drive) with version, retrieval date and checksum. Default is no snapshot. | Ontologies change between versions; frozen copies matter only for those relied on | Planned (T8b) |
| D12 | A Concept may carry an external_iri pointing at a specific term in an ontology. | Connect own concepts to standard vocabularies without importing them | Planned (T8) |
| D13 | The Drive upload path accepts more than PDFs (owl, rdf, ttl, jsonld, xml, xsd, json, csv, zip), with a size cap; items over the cap stay link-only. Public-by-link sharing is applied as for PDFs, and the UI warns to check a resource's license before storing a snapshot. | Support ontology snapshots | Planned (T8b) |
