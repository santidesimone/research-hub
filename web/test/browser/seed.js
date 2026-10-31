// Test data for the browser checks. Run against a THROWAWAY database only: HUB_URL=... HUB_API_TOKEN=... node seed.js
// Two papers go through /api/analysis, so Crossref and OpenAlex must be reachable.
const U = process.env.HUB_URL || 'http://127.0.0.1:18082';
const H = { Authorization: 'Bearer ' + process.env.HUB_API_TOKEN, 'Content-Type': 'application/json' };
const DATA = [
  ['/api/analysis', { collection: 'paper', doi: '10.1007/978-1-4757-0602-4_18', model: 'claude-opus-5-5', confidence: { main_claim: 'low' },
    fields: { contribution_type: 'theoretical', research_problem: 'How to make digital payments untraceable', main_claim: 'Blind signatures give payer privacy',
      key_findings: [{ text: 'Blind signatures allow untraceable payments', location: 'p. 199' }, { text: 'The bank cannot link withdrawals to payments' }], evidence: { type: 'formal argument', n: 1 } },
    links: [{ rel: 'ABOUT', target: 'Digital cash', kind: 'Topic' }] }],
  ['/api/analysis', { collection: 'paper', doi: '10.3390/fi13050130', model: 'claude-opus-5-5', fields: { contribution_type: 'methodological', tldr: 'An architecture for privacy-preserving retail CBDC' },
    links: [{ rel: 'BUILDS_ON', target: 'doi:10.1007/978-1-4757-0602-4_18', evidence: 'We build on Chaum blind signatures', location: 's. 2' }] }],
  ['/api/items', { collection: 'paper', fields: { title: 'A Public Preprint on Payments', authors: ['Grace Hopper'], year: 2024, visibility: 'public', abstract: 'SECRET-ABSTRACT-TEXT' } }],
  ['/api/items', { collection: 'paper', fields: { title: 'PRIVATE-PAPER-TITLE', year: 2020 } }],
  ['/api/items', { collection: 'method', fields: { title: 'Snowballing', kind: 'technique', purpose: 'Follow references and citations', procedure: ['Pick seeds', 'Go backward', 'Go forward'], domain: ['research methodology'], visibility: 'public' } }],
  ['/api/items', { collection: 'method', fields: { title: 'Difference in differences', kind: 'technique', purpose: 'Estimate causal effects', domain: ['research methodology'] } }],
  ['/api/items', { collection: 'use_case', fields: { title: 'Offline retail payments', goal: 'Pay without a network', status: 'candidate', domain: ['payments'], actors: [{ role: 'payer', organisation_type: 'household' }] } }],
  ['/api/items', { collection: 'case_study', fields: { title: 'Lisbon CBDC pilot', case_type: 'pilot', organisations: ['Banco de Portugal'], sector: 'payments', outcomes: [{ measure: 'uptake', value: '12%', direction: 'up', expected: true }] } }],
];
(async () => {
  for (const [path, body] of DATA) {
    let res, out;
    for (let attempt = 1; attempt <= 3; attempt++) { // Crossref and OpenAlex are live services: retry a hiccup
      try { res = await fetch(U + path, { method: 'POST', headers: H, body: JSON.stringify(body) }); out = await res.json(); } catch (e) { res = { status: 0 }; out = { error: e.message }; }
      if (res.status > 0 && res.status < 300) break;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    console.log(res.status, path, out.key || out.error);
    if (!(res.status > 0 && res.status < 300)) process.exitCode = 1;
  }
})();
