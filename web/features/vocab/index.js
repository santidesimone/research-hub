// Vocabulary for the owner: type-ahead look-up for the Library's pickers (GET /api/vocab?kind=Topic&q=zero, compared in the
// matcher's normalised form, so "Zero-Knowledge" finds "zero knowledge proof"), and a Concept's pointer into an ontology
// (PATCH /api/vocab?key=concept:x: external_iri and DEFINED_IN, D12). Nothing from the ontology is imported.
const express = require('express');
const { requireOwner } = require('../../core/auth');
const { run, writeTx } = require('../../core/db');
const { schema, safeLabel } = require('../../core/schema');
const vocab = require('../../core/vocab');
const { HttpError } = require('../../core/errors');

const IRI = /^[a-z][a-z0-9+.-]*:[^\s<>"]+$/i;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  name: 'vocab',
  mount(app) {
    app.get('/api/vocab', requireOwner, wrap(async (req, res) => {
      const label = vocab.labelOf(req.query.kind);
      if (String(req.query.q || '').length > 200) throw new HttpError(400, 'q is limited to 200 characters');
      const q = vocab.analyse(schema.entities[label].match, String(req.query.q || '')).norm;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 50);
      const rows = await run(
        `MATCH (n:${safeLabel(label)})
         WHERE $q = '' OR n.norm STARTS WITH $q OR n.norm CONTAINS $q OR any(a IN coalesce(n.aliases_norm, []) WHERE a STARTS WITH $q)
         RETURN n.key AS key, n.name AS name, coalesce(n.aliases, []) AS aliases, size([(n)--() | 1]) AS uses
         ORDER BY CASE WHEN n.norm STARTS WITH $q THEN 0 ELSE 1 END, uses DESC, n.name LIMIT ${limit}`, { q });
      res.json({ kind: label, items: rows });
    }));

    app.patch('/api/vocab', requireOwner, express.json({ limit: '10kb' }), wrap(async (req, res) => {
      const key = String(req.query.key || '');
      if (!key.startsWith(schema.entities.Concept.key_prefix)) throw new HttpError(400, 'Only concepts carry an external IRI: pass ?key=concept:...');
      const body = req.body || {};
      if (!('external_iri' in body) && !('defined_in' in body)) throw new HttpError(400, 'Send external_iri and/or defined_in');
      const iri = body.external_iri == null || body.external_iri === '' ? null : String(body.external_iri).trim();
      if (iri !== null && (iri.length > 500 || !IRI.test(iri))) throw new HttpError(400, 'external_iri must be an absolute IRI (e.g. https://spec.edmcouncil.org/fibo/ontology/...)');
      const definedIn = body.defined_in == null || body.defined_in === '' ? null : String(body.defined_in);
      const at = new Date().toISOString();
      const out = await writeTx(async (tx) => {
        const found = await tx.run('MATCH (c:Concept {key:$key}) RETURN c.external_iri AS iri', { key });
        if (!found.records.length) throw new HttpError(404, 'No such concept');
        const current = 'external_iri' in body ? iri : found.records[0].get('iri');
        if ('external_iri' in body) await tx.run('MATCH (c:Concept {key:$key}) SET c.external_iri = $iri, c.updated_at = datetime()', { key, iri });
        if ('defined_in' in body) {
          await tx.run('MATCH (:Concept {key:$key})-[r:DEFINED_IN]->() DELETE r', { key });
          if (definedIn) {
            const made = await tx.run(
              `MATCH (c:Concept {key:$key}) MATCH (o:Ontology {key:$o})
               MERGE (c)-[r:DEFINED_IN]->(o) SET r.external_iri = $iri, r.by = 'owner', r.at = $at, r.status = 'reviewed' RETURN o.key AS k`,
              { key, o: definedIn, iri: current, at });
            if (!made.records.length) throw new HttpError(404, `No ontology ${definedIn}`);
          }
        } else if ('external_iri' in body) {
          await tx.run('MATCH (:Concept {key:$key})-[r:DEFINED_IN]->() SET r.external_iri = $iri', { key, iri });
        }
        return { key, external_iri: current, ...('defined_in' in body ? { defined_in: definedIn } : {}) };
      });
      res.json(out);
    }));
  },
};
