import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parsers } from 'prettier/plugins/yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const requireThat = (condition) => {
  if (!condition) throw new Error('Invalid customization');
};
const list = (value) =>
  Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const readOnly = [
  'product-architect',
  'ux-agent',
  'security-agent',
  'final-auditor',
  'research-agent',
  'system-designer',
  'independent-reviewer',
  'research-reference',
  'project-manager-client',
  'code-quality',
  'product-discovery',
  'agent-operations',
  'skills-curator',
];
const builders = [
  'frontend-agent',
  'backend-agent',
  'infrastructure-agent',
  'senior-engineer',
  'visual-designer',
  'documentation',
  'repository',
  'release-manager',
];
const verifiers = ['qa-agent', 'performance-agent'];
const roles = [...readOnly, ...builders, ...verifiers, 'orchestrator'];
const baseTools = [
  'search',
  'read',
  'web',
  'fetch',
  'execute/getTerminalOutput',
  'vscode/askQuestions',
  'vscode.mermaid-markdown-features/renderMermaidDiagram',
];
const promptNames = ['audit', 'implement', 'review', 'qa', 'release', 'full-loop'];
const instructionNames = [
  'architecture',
  'backend',
  'database',
  'documentation',
  'frontend',
  'security',
  'testing',
];

function yamlValue(node, depth = 0) {
  requireThat(node && depth < 32 && !node.anchor && !node.tag);
  const children = node.children ?? [];
  if (['mapping', 'flowMapping'].includes(node.type)) {
    const result = Object.create(null);
    for (const item of children) {
      const key = yamlValue(item.children[0], depth + 1);
      requireThat(text(key) && key !== '<<' && !Object.hasOwn(result, key));
      result[key] = yamlValue(item.children[1], depth + 1);
    }
    return result;
  }
  if (['sequence', 'flowSequence'].includes(node.type))
    return children.map((child) => yamlValue(child, depth + 1));
  if (['mappingKey', 'mappingValue', 'sequenceItem', 'flowSequenceItem'].includes(node.type)) {
    requireThat(children.length === 1);
    return yamlValue(children[0], depth + 1);
  }
  requireThat(
    ['plain', 'quoteSingle', 'quoteDouble', 'blockFolded', 'blockLiteral'].includes(node.type),
  );
  if (node.type === 'plain') {
    if (/^(?:null|~)$/i.test(node.value)) return null;
    if (/^(?:true|false)$/i.test(node.value)) return node.value.toLowerCase() === 'true';
    if (/^[+-]?\d+(?:\.\d+)?$/.test(node.value)) return Number(node.value);
  }
  return node.value;
}

export async function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  requireThat(match);
  const ast = await parsers.yaml.parse(match[1]);
  requireThat(ast.children.length === 1);
  const body = ast.children[0].children.find((node) => node.type === 'documentBody');
  requireThat(
    body?.children.length === 1 && ['mapping', 'flowMapping'].includes(body.children[0].type),
  );
  return yamlValue(body.children[0]);
}

export function validateAgentGrants(role, agent, names) {
  requireThat(roles.includes(role) && list(agent.tools) && list(agent.agents));
  const allowed = new Set(baseTools);
  if (role === 'final-auditor') allowed.add('execute/testFailure');
  if (builders.includes(role) || role === 'orchestrator')
    for (const tool of ['edit', 'execute', 'todos']) allowed.add(tool);
  if (verifiers.includes(role)) allowed.add('execute');
  if (role === 'orchestrator') allowed.add('agent');
  requireThat(agent.tools.every((tool) => allowed.has(tool)));
  if (builders.includes(role) || role === 'orchestrator')
    requireThat(agent.tools.includes('edit') && agent.tools.includes('execute'));
  if (verifiers.includes(role)) requireThat(agent.tools.includes('execute'));
  if (role === 'orchestrator') {
    requireThat(agent.name === 'CareerScope Orchestrator');
    requireThat(agent.tools.includes('agent') && agent.agents.length === names.size - 1);
    requireThat(agent.agents.every((name) => name !== agent.name && names.has(name)));
  } else requireThat(agent.agents.length === 0);
  requireThat(!Object.hasOwn(agent, 'hooks'));
  if (Object.hasOwn(agent, 'handoffs')) {
    requireThat(Array.isArray(agent.handoffs));
    requireThat(agent.handoffs.every((handoff) => names.has(handoff.agent)));
  }
}

export function validateHookConfig(config) {
  const keys = (value, expected) =>
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
  requireThat(keys(config, ['hooks']) && keys(config.hooks, ['SessionStart']));
  const commands = config.hooks.SessionStart;
  requireThat(Array.isArray(commands) && commands.length === 1);
  const hook = commands[0];
  requireThat(keys(hook, ['type', 'command', 'timeout']));
  requireThat(
    hook.type === 'command' &&
      hook.command === 'node scripts/engineering-hook.mjs' &&
      hook.timeout === 10,
  );
}

export function validateReviewSnapshot(source) {
  const entries = [...source.matchAll(/^Date:\s*\S.*$/gm)];
  requireThat(entries.length > 0);
  const latest = source.slice(entries.at(-1).index);
  requireThat(/^Revision:\s*[a-f0-9]{40}(?:[a-f0-9]{24})?\s*$/m.test(latest));
  requireThat(/^(?:Content )?Digest:\s*[a-f0-9]{64}\s*$/m.test(latest));
  for (const heading of ['TESTING', 'FINAL STATUS', 'REMAINING ISSUES', 'NEXT ACTION']) {
    const section = new RegExp(`^## ${heading}\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(
      latest,
    );
    requireThat(section && text(section[1]));
  }
}

export async function checkCustomizations(directory = root) {
  const failures = [];
  const counts = { agents: 0, prompts: 0, instructions: 0, skills: 0 };
  const check = async (label, action) => {
    try {
      await action();
    } catch {
      failures.push(label);
    }
  };
  const read = (file) => {
    let current = directory;
    for (const part of file.split('/')) {
      current = join(current, part);
      requireThat(!lstatSync(current).isSymbolicLink());
    }
    const stat = lstatSync(current);
    requireThat(stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024);
    return readFileSync(current, 'utf8');
  };
  const scan = (folder, suffix) => {
    const found = [];
    const visit = (path, depth) => {
      requireThat(depth < 8 && !lstatSync(join(directory, path)).isSymbolicLink());
      for (const entry of readdirSync(join(directory, path), { withFileTypes: true })) {
        requireThat(!entry.isSymbolicLink());
        const file = `${path}/${entry.name}`;
        if (entry.isDirectory()) visit(file, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(file);
        requireThat(found.length <= 500);
      }
    };
    visit(folder, 0);
    requireThat(found.length > 0);
    return found.sort();
  };
  const agents = new Map();
  const collections = [
    ['agents', '.github/agents', '.agent.md'],
    ['prompts', '.github/prompts', '.prompt.md'],
    ['instructions', '.github/instructions', '.instructions.md'],
    ['skills', '.github/skills', 'SKILL.md'],
  ];
  const metadata = new Map();
  for (const [kind, folder, suffix] of collections) {
    await check(`${kind}: readable, nonempty collection`, async () => {
      for (const file of scan(folder, suffix)) {
        counts[kind] += 1;
        await check(`${file}: valid YAML frontmatter and required metadata`, async () => {
          const matter = await parseFrontmatter(read(file));
          requireThat(text(matter.description));
          if (kind === 'agents' || kind === 'skills') requireThat(text(matter.name));
          if (kind === 'instructions') requireThat(text(matter.applyTo));
          if (kind === 'skills') requireThat(matter.name === basename(dirname(file)));
          if (kind === 'agents') {
            requireThat(matter.target === 'vscode' && !agents.has(matter.name));
            agents.set(matter.name, { file, matter });
          }
          metadata.set(file, matter);
        });
      }
    });
  }
  await check('all 24 known agent roles exist without extras', () => {
    requireThat(counts.agents === roles.length);
    for (const role of roles)
      requireThat(metadata.has(`.github/agents/careerscope-${role}.agent.md`));
  });
  const names = new Set(agents.keys());
  for (const { file, matter } of agents.values())
    await check(`${file}: known role grants and exact delegation targets`, () => {
      validateAgentGrants(
        basename(file).slice('careerscope-'.length, -'.agent.md'.length),
        matter,
        names,
      );
    });
  for (const [file, matter] of metadata) {
    if (!file.endsWith('.prompt.md')) continue;
    await check(`${file}: exact agent target and no tool override`, () => {
      requireThat(!Object.hasOwn(matter, 'tools') && !Object.hasOwn(matter, 'hooks'));
      if (Object.hasOwn(matter, 'agent')) requireThat(names.has(matter.agent));
    });
  }
  for (const name of promptNames)
    await check(`required prompt careerscope-${name}: Orchestrator target`, () => {
      requireThat(
        metadata.get(`.github/prompts/careerscope-${name}.prompt.md`)?.agent ===
          'CareerScope Orchestrator',
      );
    });
  for (const name of instructionNames)
    await check(`required scoped instruction: ${name}`, () => {
      requireThat(metadata.has(`.github/instructions/${name}.instructions.md`));
    });
  await check('engineering hook: exact SessionStart-only native command', () =>
    validateHookConfig(JSON.parse(read('.github/hooks/engineering.json'))),
  );
  await check(
    'latest review snapshot: Revision, Digest, TESTING, FINAL STATUS, REMAINING ISSUES, NEXT ACTION required',
    () => validateReviewSnapshot(read('review.txt')),
  );
  return { valid: failures.length === 0, counts, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await checkCustomizations();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.valid ? 0 : 1;
}
