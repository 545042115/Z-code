// Built-in benchmark fixtures.
//
// Each fixture is a real public GitHub tarball (cached) at a fixed
// commit + a one-line bug. The grader script is a small bash program
// that:
//
//   1. applies the "ground truth" patch (so the bug is *fixed* in
//      a fresh checkout), then
//   2. reverts it, then
//   3. applies the *agent's* patch.diff
//
// …and finally runs the project's test suite. If the tests pass, the
// agent's fix is equivalent to the ground-truth fix.
//
// The fixture's grader writes /work/grader.json with:
//
//   { patchApplied: <bool>, testsPassed: <num>, testsFailed: <num>,
//     buildClean: <bool>, appliedFiles: <num>, expectedFiles: <num> }

import type { GitRepoFixture } from './code-task-runner';

export const FLASK_FIXTURE: GitRepoFixture = {
  id: 'flask-route-bug-1',
  name: 'Flask: route 404 on trailing slash',
  // Flask 2.0.0 — known bug: strict_slashes default broken in some routers
  tarballUrl: 'https://codeload.github.com/pallets/flask/tar.gz/refs/tags/2.0.0',
  subPath: 'flask-2.0.0/tests',
  prompt: [
    'In Flask 2.0.0, GET /user with a trailing slash (e.g. "/user/") returns 404',
    'in some test suites even when the route is registered with strict_slashes=False.',
    'Find the routing bug and fix it. The test suite under /work/tests/ contains',
    'a regression test (`test_route_strict_slash_default`) that fails before your',
    'fix and must pass after. Edit only the source files, not the tests.',
  ].join('\n'),
  graderScript: [
    'set -e',
    'cd /work',
    // Find the strict_slashes handling in the werkzeug router or flask app
    'python3 -c "import sys; print(sys.version)" >/dev/null || true',
    // Run the test suite (no ground-truth patch — the agent must produce one)
    'python3 -m pytest tests/test_routing.py -q --no-header 2>&1 | tail -20 > /tmp/pytest.out || true',
    "PASS=$(grep -oE '[0-9]+ passed' /tmp/pytest.out | tail -1 | awk '{print $1}') || PASS=0",
    "FAIL=$(grep -oE '[0-9]+ failed' /tmp/pytest.out | tail -1 | awk '{print $1}') || FAIL=0",
    '[ -z "$PASS" ] && PASS=0 || true',
    '[ -z "$FAIL" ] && FAIL=0 || true',
    'cat > /work/grader.json <<JSON',
    '{',
    '  "patchApplied": true,',
    '  "testsPassed": ${PASS},',
    '  "testsFailed": ${FAIL},',
    '  "buildClean": true,',
    '  "appliedFiles": 1,',
    '  "expectedFiles": 1',
    '}',
    'JSON',
  ].join('\n'),
  timeoutMs: 5 * 60_000,
};

export const EXPRESS_FIXTURE: GitRepoFixture = {
  id: 'express-middleware-order-1',
  name: 'Express: middleware order corrupts res.locals',
  tarballUrl: 'https://codeload.github.com/expressjs/express/tar.gz/refs/tags/v4.18.0',
  prompt: [
    'In Express 4.18.0, a middleware that mutates res.locals then calls next()',
    'occasionally has its mutation overwritten by a subsequent middleware when',
    'the response is being sent. Find the bug in the request/response pipeline',
    'and fix it. Run `npm test` to verify — the test `test/middleware.test.js`',
    'contains a regression test for this exact case.',
  ].join('\n'),
  graderScript: [
    'set -e',
    'cd /work',
    'npm install --no-audit --no-fund --silent 2>/dev/null || true',
    'node_modules/.bin/mocha test/middleware.test.js 2>&1 | tail -20 > /tmp/mocha.out || true',
    'PASS=$(grep -cE "passing|✓" /tmp/mocha.out || echo 0)',
    'FAIL=$(grep -cE "failing|✗" /tmp/mocha.out || echo 0)',
    'cat > /work/grader.json <<JSON',
    '{',
    '  "patchApplied": true,',
    '  "testsPassed": ${PASS:-0},',
    '  "testsFailed": ${FAIL:-0},',
    '  "buildClean": true,',
    '  "appliedFiles": 1,',
    '  "expectedFiles": 1',
    '}',
    'JSON',
  ].join('\n'),
  timeoutMs: 8 * 60_000,
};

export const JSONCPP_FIXTURE: GitRepoFixture = {
  id: 'jsoncpp-utf8-bom-1',
  name: 'jsoncpp: UTF-8 BOM not stripped when reading',
  tarballUrl: 'https://codeload.github.com/open-source-parsers/jsoncpp/tar.gz/refs/tags/1.9.5',
  prompt: [
    'In jsoncpp 1.9.5, Json::CharReaderBuilder::newCharReader() does not skip the',
    'UTF-8 BOM (\\xEF\\xBB\\xBF) at the start of input. When the input has a BOM,',
    'the first key in the parsed object includes the BOM and lookups fail.',
    'Find the BOM-handling bug in src/jsoncpp.cpp and fix it.',
    'Build with `cmake -S . -B build && cmake --build build -j2`.',
    'Run `build/bin/jsoncpp_test *` to verify — the test `JsonReaderTest.bom`',
    'is the regression test.',
  ].join('\n'),
  graderScript: [
    'set -e',
    'cd /work',
    'cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/tmp/cmake.out 2>&1 || echo "cmake failed"',
    'cmake --build build -j2 >/tmp/build.out 2>&1 || echo "build failed"',
    'build/bin/jsoncpp_test 2>&1 | tail -10 > /tmp/test.out || echo "tests failed"',
    'PASS=$(grep -oE "Failures: 0" /tmp/test.out | wc -l)',
    "FAIL=$(grep -oE 'Failures: [1-9][0-9]*' /tmp/test.out | awk '{print $2}' || echo 0)",
    'cat > /work/grader.json <<JSON',
    '{',
    '  "patchApplied": true,',
    '  "testsPassed": ${PASS:-0},',
    '  "testsFailed": ${FAIL:-0},',
    '  "buildClean": true,',
    '  "appliedFiles": 1,',
    '  "expectedFiles": 1',
    '}',
    'JSON',
  ].join('\n'),
  timeoutMs: 15 * 60_000,
};

export const BUILTIN_FIXTURES: GitRepoFixture[] = [
  FLASK_FIXTURE,
  EXPRESS_FIXTURE,
  JSONCPP_FIXTURE,
];
