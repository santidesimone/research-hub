// Notes become thoughts; projects go (Task 11 step 6, docs/UI_REDESIGN.md sections 4 and 7).
// - Every Note gets a Thought copy (key thought:note-<name>, state kept, its title and text, imported_from the note's
//   key) with the note's links that a thought may have (ANNOTATES, CRITIQUES, SUPPORTS, CONTRADICTS, ABOUT), same
//   properties. Written as the owner's content.
// - Nothing is deleted here: one curation plan (by the hub) proposes deleting the old notes and every project, for the
//   owner to apply, reject or undo in Review. Idempotent: a copy that exists is left alone, the plan is made once.
const COPY = ['ANNOTATES', 'CRITIQUES', 'SUPPORTS', 'CONTRADICTS', 'ABOUT'];

module.exports = {
  id: '015_thoughts',
  description: 'notes become thoughts (state kept, links copied); a curation plan proposes removing the notes and projects',
  async up(db) {
    const notes = await db.run(`MATCH (n:Note) WHERE n.key IS NOT NULL
      RETURN n.key AS key, n.title AS title, n.body AS body, n.summary AS summary, n.visibility AS visibility ORDER BY key`);
    if (notes.length) {
      const items = require('../core/items');
      for (const n of notes) {
        const key = 'thought:note-' + n.key.replace(/^note:/, '');
        const [have] = await db.run('MATCH (t:Thought {key: $key}) RETURN t.key AS key', { key });
        if (!have) {
          const text = [n.title, n.summary, n.body].filter((x) => typeof x === 'string' && x.trim()).filter((x, i, a) => a.indexOf(x) === i).join('\n\n') || n.key;
          await items.write(key, { text, title: (n.title || text).slice(0, 200), state: 'kept', visibility: n.visibility === 'public' ? 'public' : 'private' },
            { by: 'owner', create: { collection: 'thought' } });
          await db.run('MATCH (t:Thought {key: $key}) SET t.imported_from = $note', { key, note: n.key });
        }
        for (const rel of COPY) {
          await db.run(`MATCH (n:Note {key: $note})-[r:${rel}]->(x), (t:Thought {key: $key})
            MERGE (t)-[c:${rel}]->(x) ON CREATE SET c = properties(r)`, { note: n.key, key });
        }
      }
    }
    const done = await db.run("MATCH (c:CurationPlan) WHERE c.reason STARTS WITH 'Migration 015' RETURN count(c) AS n");
    if (done.length && Number(done[0].n) > 0) return;
    const old = await db.run('MATCH (n) WHERE (n:Note OR n:Project) AND n.key IS NOT NULL RETURN n.key AS key ORDER BY key');
    const curation = require('../core/curation');
    for (let i = 0; i < old.length; i += 50) { // a plan holds at most 50 operations
      await curation.propose(old.slice(i, i + 50).map((o) => ({ op: 'delete', key: o.key })), {
        by: 'hub', reason: 'Migration 015: notes are now thoughts (each one copied, with its links, under Thoughts) and projects are no longer part of the hub. Apply to delete the old notes and projects; Reject keeps them.',
      });
    }
  },
};
