"""Allowlisted handoff archive and SHA-256 manifest. Never reads private env files."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys
import zipfile

PROJECT = Path(__file__).resolve().parents[1]
WORKSPACE = PROJECT.parent
CONTEXT = WORKSPACE / '_ai_context'
OUT = CONTEXT / 'submission'
ARTIFACTS = CONTEXT / 'artifacts'
subprocess.run([sys.executable, str(PROJECT/'scripts/validate-submission.py')], check=True,
               stdout=subprocess.DEVNULL)
required = ['README.md', 'REPORT.md', 'SLIDES.md', 'ARCHITECTURE.md', 'DEMO_RUNBOOK.md',
            'ACCEPTANCE.md', 'VIVA.md', 'RELEASE_CHECKLIST.md', 'REHEARSAL.md',
            'PulseGrid-Report.docx', 'PulseGrid-Report.pdf', 'PulseGrid-Slides.pptx',
            'PulseGrid-Slides.pdf', 'architecture.svg', 'architecture.png',
            'PulseGrid-Demo.mp4', 'PulseGrid-Demo.webm', 'demo-transcript.md',
            'offline-sandbox/index.html', 'offline-sandbox/START.ps1',
            'offline-sandbox/README.txt']
for name in required:
    if not (OUT / name).is_file() or not (OUT / name).stat().st_size:
        raise SystemExit(f'Missing or empty required artifact: {name}')

# Read-only source selection: only explicit project directories and root file types.
source_dirs = ['src', 'public', 'docs', 'scripts', 'tests', '.github']
root_files = ['package.json', 'package-lock.json', 'README.md', 'CONTRIBUTING.md',
              '.env.example', '.gitignore', '.editorconfig', '.nvmrc',
              'next-env.d.ts', 'tsconfig.json', 'next.config.ts', 'vercel.json',
              'eslint.config.mjs', 'postcss.config.mjs', 'playwright.config.ts',
              'playwright.preview.config.ts', 'vitest.config.mts',
              'vitest.integration.config.mts', 'vitest.workflow.config.mts',
              'vitest.cache.config.mts', 'vitest.surge.config.mts']
files = [PROJECT / f for f in root_files if (PROJECT/f).is_file()]
for directory in source_dirs:
    files += [p for p in (PROJECT/directory).rglob('*') if p.is_file() and not p.is_symlink()
              and '__pycache__' not in p.parts and p.suffix != '.pyc']
files += list(CONTEXT.glob('*.md'))
files += [p for p in OUT.rglob('*') if p.is_file() and p.name not in
          ['manifest.json', 'PulseGrid-Submission.zip'] and not p.is_symlink()]
# Retain only known, sanitized machine reports and screenshots, never session/trace dumps.
evidence_names = ['stage-14-checks.json', 'stage-14-waste-report.json',
                  'stage-12-ten-acknowledgements.json', 'stage-13-surge-local.json',
                  'stage-7-inngest-live.json', 'stage-8-cache-runtime.json']
files += [ARTIFACTS/name for name in evidence_names if (ARTIFACTS/name).is_file()]
files += [p for p in ARTIFACTS.glob('stage-15-*') if p.is_file() and p.suffix in
          ['.json', '.txt', '.png'] and 'debug' not in p.name and 'tool-install' not in p.name
          and p.name not in ['stage-15-package-checks.json', 'stage-15-browser-tests.json']]
files = sorted(set(files))
safe_files = []
for path in files:
    resolved = path.resolve()
    if not resolved.is_relative_to(WORKSPACE.resolve()) or path.is_symlink():
        raise SystemExit('Unsafe path outside workspace')
    relative = path.relative_to(WORKSPACE)
    if any(part in ['.git', 'node_modules', '.next', '.tools', '.npm-cache', '__pycache__'] for part in relative.parts):
        raise SystemExit(f'Unexpected private/tool directory: {relative}')
    if path.name.startswith('.env') and path.name != '.env.example':
        raise SystemExit('Private environment file is forbidden')
    if re.search(r'(storage.state|auth-state|session-state|\.pem$|\.key$)', path.name, re.I):
        raise SystemExit('Private identity/key artifact is forbidden')
    safe_files.append(path)

# Validate local Markdown targets in the newly authored submission surfaces.
broken = []
for path in list(OUT.glob('*.md')) + [PROJECT/'docs/submission.md']:
    for label, target in re.findall(r'\[([^\]]+)\]\(([^)]+)\)', path.read_text(encoding='utf-8')):
        if re.match(r'^[a-z]+:', target, re.I) or target.startswith('#'):
            continue
        local = target.split('#')[0]
        if local and not (path.parent/local).resolve().exists():
            broken.append({'file': str(path.relative_to(WORKSPACE)), 'target': target})
if broken:
    raise SystemExit('Broken local document links: '+json.dumps(broken))

# High-confidence credential signatures; do not print matched values.
patterns = [r'mongodb(?:\+srv)?://[^\s/"\']+:[^\s@"\']+@',
            r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
            r'\bghp_[A-Za-z0-9]{30,}\b', r'\bgithub_pat_[A-Za-z0-9_]{40,}\b',
            r'\bsk_live_[A-Za-z0-9]{20,}\b', r'\bsk-proj-[A-Za-z0-9_-]{30,}\b']
text_suffixes = ['.md', '.ts', '.tsx', '.mts', '.mjs', '.json', '.txt', '.html', '.svg', '.yml', '.yaml', '.py', '.ps1']
for path in safe_files:
    if path.suffix in text_suffixes or path.name == '.env.example':
        raw = path.read_bytes()
        content = raw.decode('utf-16' if raw.startswith(b'\xff\xfe') else 'utf-8-sig', errors='replace')
        if path.relative_to(WORKSPACE).as_posix() == 'project/tests/integration/registry.test.ts':
            # Exact existing fake error text for the sanitized-response regression.
            # This is not a service URI; no broader test-directory exemption exists.
            content = content.replace('mongodb://' + 'secret:password@private-host', '[synthetic error fixture]')
        if any(re.search(pattern, content) for pattern in patterns):
            raise SystemExit(f'Credential-pattern check failed in {path.relative_to(WORKSPACE)} (value redacted)')

inventory = [{'path': path.relative_to(WORKSPACE).as_posix(), 'bytes': path.stat().st_size,
              'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in safe_files]
manifest = {'date': '2026-10-29', 'timezone': 'Asia/Calcutta',
            'status': 'Local submission candidate; hosted/college/human release gates remain open',
            'entryPoint': '_ai_context/submission/README.md', 'files': inventory,
            'safety': {'selection': 'allowlisted source/docs/evidence; private env, Git, caches, auth states excluded',
                       'credentialPatternScan': 'passed; heuristic, not a substitute for independent review',
                       'syntheticFixtureException': 'one exact fake MongoDB error literal in tests/integration/registry.test.ts'},
            'localLinks': 'all newly authored Markdown file targets exist'}
(OUT/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
archive_path = OUT/'PulseGrid-Submission.zip'
with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for path in safe_files:
        archive.write(path, path.relative_to(WORKSPACE).as_posix())
    archive.write(OUT/'manifest.json', '_ai_context/submission/manifest.json')
with zipfile.ZipFile(archive_path) as archive:
    if archive.testzip() is not None:
        raise SystemExit('ZIP CRC check failed')
    for row in inventory:
        if hashlib.sha256(archive.read(row['path'])).hexdigest() != row['sha256']:
            raise SystemExit('Archived content hash mismatch')
summary = {'files': len(inventory), 'archiveBytes': archive_path.stat().st_size,
           'archiveSHA256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
           'crcAndAllContentHashes': 'passed', 'missingArtifacts': [], 'brokenLocalLinks': [],
           'privateFilesExcluded': True, 'credentialPatternScan': 'passed'}
(ARTIFACTS/'stage-15-package-checks.json').write_text(json.dumps(summary, indent=2)+'\n', encoding='utf-8')
print(json.dumps(summary, indent=2))
