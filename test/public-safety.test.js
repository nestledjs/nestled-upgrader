import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findIdentifying, identifyingTerms } from '../lib/public-safety.js';
import { draftUpstreamReport } from '../lib/report-upstream.js';

const config = {
  promotion: { source: { name: 'example-dev-template', path: '../example-dev-template' } },
  template: { name: 'example-template', path: '../example-template' },
  projects: [
    { name: 'example-template', path: '../example-template' },
    { name: 'project-a', path: '../project-a' },
    { name: 'shop', path: '../clients/shop-site' }
  ],
  publicSafety: { terms: ['Acme Corp'] }
};

test('identifying terms come from project names, path basenames and configured terms, never the template', () => {
  const terms = identifyingTerms(config);
  assert.deepEqual(terms.sort(), ['acme corp', 'project-a', 'shop', 'shop-site'].sort());
});

test('flags project names as whole words only', () => {
  assert.equal(findIdentifying('A bug found in project-a during reset.', config).length, 1);
  assert.equal(findIdentifying('Shopping carts and workshops are fine.', config).length, 0);
  assert.equal(findIdentifying('Reported by ACME CORP staff.', config)[0].kind, 'term');
});

test('flags links to non-public repositories and absolute local paths', () => {
  const findings = findIdentifying(
    'See https://github.com/some-client/private-app/pull/3 and /Users/me/IdeaProjects/x/README.md',
    config
  );
  assert.deepEqual(findings.map((f) => f.kind).sort(), ['local-path', 'private-repo']);
  assert.equal(findIdentifying('Upstream: https://github.com/nestledjs/nestled-template/issues/1', config).length, 0);
});

test('template-relative text passes', () => {
  assert.equal(findIdentifying('register() mints a token without checking the primary address.', config).length, 0);
});

test('report-upstream refuses a draft that names a project', () => {
  const result = draftUpstreamReport(config, [], { title: 'Bug in project-a', description: 'reset keeps sessions' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.length > 0);
});

test('report-upstream builds a prefilled issue URL, and points security reports at private reporting', () => {
  const issue = draftUpstreamReport(config, [], { title: 'Reset keeps sessions', description: 'resetPassword() leaves sessions valid.' });
  assert.equal(issue.ok, true);
  assert.match(issue.url, /^https:\/\/github\.com\/nestledjs\/nestled-dev-template\/issues\/new\?template=bug\.yml&/);
  assert.match(decodeURIComponent(issue.url.replace(/\+/g, ' ')), /what=resetPassword\(\) leaves sessions valid\./);

  const secret = draftUpstreamReport(config, [], { title: 'x', description: 'y', security: true });
  assert.equal(secret.url, 'https://github.com/nestledjs/nestled-dev-template/security/advisories/new');
});

test('report-upstream requires a title and description', () => {
  assert.equal(draftUpstreamReport(config, [], { title: 'only a title' }).ok, false);
});
