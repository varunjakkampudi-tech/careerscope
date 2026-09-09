/**
 * Skill taxonomy: canonical names, the aliases boards actually write, family
 * groupings for partial credit, and a rarity weight used as an IDF proxy.
 *
 * This lives in `shared` because three consumers need the same vocabulary — the
 * resume parser, the matching engine, and the profile form's skill autocomplete.
 * A skill spelled three ways across a resume, a JD and a user's profile must
 * collapse to one token or the match percentage is meaningless.
 */

export interface SkillDef {
  /** Display form, e.g. "Node.js". */
  name: string;
  /** Lowercase spellings seen in the wild. The canonical name is added automatically. */
  aliases?: string[];
  /**
   * Skills in the same family earn partial credit for each other — someone who
   * knows Vue is a plausible hire for a React role, and the score should say so
   * rather than treating them as unrelated.
   */
  family?: string;
  /**
   * IDF proxy, 0.5 (everyone lists it) .. 2.0 (genuinely differentiating).
   * A JD asking for JavaScript and Temporal should weight Temporal far higher.
   */
  rarity: number;
  /**
   * Short or ambiguous names ("Go", "C", "R") that would false-positive on
   * ordinary prose. These only count inside a list or next to a language word.
   */
  needsContext?: boolean;
}

const defs: SkillDef[] = [
  // ── Languages ──────────────────────────────────────────────────────────────
  {
    name: 'JavaScript',
    aliases: ['js', 'ecmascript', 'es6', 'es2015'],
    family: 'lang-web',
    rarity: 0.6,
  },
  { name: 'TypeScript', aliases: ['ts'], family: 'lang-web', rarity: 0.9 },
  { name: 'Python', aliases: ['python3', 'py'], family: 'lang-general', rarity: 0.8 },
  {
    name: 'Java',
    aliases: ['java8', 'java 11', 'java 17', 'core java'],
    family: 'lang-jvm',
    rarity: 0.8,
  },
  { name: 'Kotlin', family: 'lang-jvm', rarity: 1.4 },
  { name: 'Scala', family: 'lang-jvm', rarity: 1.6, needsContext: true },
  { name: 'Groovy', family: 'lang-jvm', rarity: 1.7 },
  { name: 'C#', aliases: ['csharp', 'c sharp'], family: 'lang-dotnet', rarity: 1.1 },
  { name: 'C++', aliases: ['cpp', 'c plus plus'], family: 'lang-systems', rarity: 1.2 },
  { name: 'C', family: 'lang-systems', rarity: 1.2, needsContext: true },
  { name: 'Go', aliases: ['golang'], family: 'lang-systems', rarity: 1.4, needsContext: true },
  { name: 'Rust', family: 'lang-systems', rarity: 1.7, needsContext: true },
  { name: 'Ruby', family: 'lang-general', rarity: 1.4 },
  { name: 'PHP', family: 'lang-general', rarity: 1.1 },
  { name: 'Swift', family: 'lang-mobile', rarity: 1.4, needsContext: true },
  { name: 'Objective-C', aliases: ['objective c', 'objc'], family: 'lang-mobile', rarity: 1.6 },
  { name: 'Dart', family: 'lang-mobile', rarity: 1.6, needsContext: true },
  { name: 'R', family: 'lang-data', rarity: 1.5, needsContext: true },
  { name: 'Elixir', family: 'lang-general', rarity: 1.9 },
  { name: 'Erlang', family: 'lang-general', rarity: 1.9 },
  { name: 'Clojure', family: 'lang-jvm', rarity: 1.9 },
  { name: 'Haskell', family: 'lang-general', rarity: 1.9 },
  { name: 'Perl', family: 'lang-general', rarity: 1.7 },
  { name: 'Lua', family: 'lang-general', rarity: 1.8 },
  { name: 'Solidity', family: 'lang-web3', rarity: 1.9 },
  { name: 'SQL', aliases: ['ansi sql'], family: 'data-query', rarity: 0.6 },
  { name: 'PL/SQL', aliases: ['plsql'], family: 'data-query', rarity: 1.4 },
  { name: 'T-SQL', aliases: ['tsql', 'transact-sql'], family: 'data-query', rarity: 1.4 },
  {
    name: 'Bash',
    aliases: ['shell scripting', 'shell script', 'sh scripting'],
    family: 'ops',
    rarity: 0.9,
  },
  { name: 'PowerShell', family: 'ops', rarity: 1.4 },

  // ── Frontend ───────────────────────────────────────────────────────────────
  { name: 'React', aliases: ['react.js', 'reactjs'], family: 'fe-framework', rarity: 0.8 },
  { name: 'Next.js', aliases: ['nextjs', 'next js'], family: 'fe-framework', rarity: 1.2 },
  { name: 'Remix', family: 'fe-framework', rarity: 1.8 },
  {
    name: 'Angular',
    aliases: ['angularjs', 'angular 2', 'angular js'],
    family: 'fe-framework',
    rarity: 1.1,
  },
  { name: 'Vue', aliases: ['vue.js', 'vuejs'], family: 'fe-framework', rarity: 1.3 },
  { name: 'Nuxt', aliases: ['nuxt.js', 'nuxtjs'], family: 'fe-framework', rarity: 1.8 },
  { name: 'Svelte', aliases: ['sveltekit'], family: 'fe-framework', rarity: 1.8 },
  { name: 'Solid.js', aliases: ['solidjs'], family: 'fe-framework', rarity: 1.9 },
  { name: 'jQuery', family: 'fe-framework', rarity: 1.0 },
  { name: 'Redux', aliases: ['redux toolkit', 'rtk'], family: 'fe-state', rarity: 1.0 },
  { name: 'Zustand', family: 'fe-state', rarity: 1.7 },
  { name: 'MobX', family: 'fe-state', rarity: 1.7 },
  {
    name: 'React Query',
    aliases: ['tanstack query', 'react-query'],
    family: 'fe-state',
    rarity: 1.5,
  },
  { name: 'RxJS', family: 'fe-state', rarity: 1.6 },
  { name: 'HTML5', aliases: ['html'], family: 'fe-markup', rarity: 0.5 },
  { name: 'CSS3', aliases: ['css'], family: 'fe-markup', rarity: 0.5 },
  { name: 'SASS', aliases: ['scss'], family: 'fe-markup', rarity: 0.9 },
  { name: 'Tailwind CSS', aliases: ['tailwind', 'tailwindcss'], family: 'fe-markup', rarity: 1.2 },
  { name: 'Bootstrap', family: 'fe-markup', rarity: 0.8 },
  { name: 'Material UI', aliases: ['mui', 'material-ui'], family: 'fe-markup', rarity: 1.1 },
  { name: 'Styled Components', aliases: ['styled-components'], family: 'fe-markup', rarity: 1.3 },
  { name: 'Storybook', family: 'fe-tooling', rarity: 1.4 },
  { name: 'Webpack', family: 'fe-tooling', rarity: 1.0 },
  { name: 'Vite', family: 'fe-tooling', rarity: 1.3 },
  { name: 'Babel', family: 'fe-tooling', rarity: 1.1 },
  { name: 'ESBuild', aliases: ['esbuild'], family: 'fe-tooling', rarity: 1.6 },
  { name: 'Turbopack', family: 'fe-tooling', rarity: 1.9 },
  { name: 'Web Components', family: 'fe-framework', rarity: 1.6 },
  {
    name: 'Micro Frontends',
    aliases: ['micro-frontend', 'module federation'],
    family: 'fe-arch',
    rarity: 1.7,
  },
  { name: 'Accessibility', aliases: ['a11y', 'wcag', 'aria'], family: 'fe-quality', rarity: 1.4 },
  {
    name: 'Responsive Design',
    aliases: ['responsive web design'],
    family: 'fe-quality',
    rarity: 0.8,
  },
  {
    name: 'Web Performance',
    aliases: ['core web vitals', 'lighthouse', 'page speed'],
    family: 'fe-quality',
    rarity: 1.5,
  },
  { name: 'Three.js', aliases: ['threejs', 'webgl'], family: 'fe-graphics', rarity: 1.8 },
  { name: 'D3.js', aliases: ['d3js', 'd3'], family: 'fe-graphics', rarity: 1.7 },

  // ── Backend ────────────────────────────────────────────────────────────────
  { name: 'Node.js', aliases: ['nodejs', 'node'], family: 'be-runtime', rarity: 0.8 },
  { name: 'Express.js', aliases: ['express', 'expressjs'], family: 'be-framework', rarity: 0.9 },
  { name: 'NestJS', aliases: ['nest.js', 'nest js'], family: 'be-framework', rarity: 1.5 },
  { name: 'Fastify', family: 'be-framework', rarity: 1.7 },
  { name: 'Deno', family: 'be-runtime', rarity: 1.8 },
  { name: 'Bun', family: 'be-runtime', rarity: 1.8 },
  { name: 'Spring Boot', aliases: ['springboot', 'spring'], family: 'be-framework', rarity: 1.1 },
  { name: 'Hibernate', aliases: ['jpa'], family: 'be-orm', rarity: 1.3 },
  { name: 'Micronaut', family: 'be-framework', rarity: 1.9 },
  { name: 'Quarkus', family: 'be-framework', rarity: 1.9 },
  { name: 'Django', family: 'be-framework', rarity: 1.3 },
  { name: 'Flask', family: 'be-framework', rarity: 1.3 },
  { name: 'FastAPI', family: 'be-framework', rarity: 1.5 },
  { name: 'Celery', family: 'be-async', rarity: 1.6 },
  {
    name: '.NET',
    aliases: ['dotnet', 'asp.net', '.net core', 'dot net'],
    family: 'lang-dotnet',
    rarity: 1.1,
  },
  { name: 'Entity Framework', aliases: ['ef core'], family: 'be-orm', rarity: 1.5 },
  { name: 'Laravel', family: 'be-framework', rarity: 1.4 },
  { name: 'Symfony', family: 'be-framework', rarity: 1.7 },
  { name: 'Ruby on Rails', aliases: ['rails', 'ror'], family: 'be-framework', rarity: 1.5 },
  { name: 'Prisma', family: 'be-orm', rarity: 1.5 },
  { name: 'TypeORM', family: 'be-orm', rarity: 1.5 },
  { name: 'Sequelize', family: 'be-orm', rarity: 1.4 },
  { name: 'Mongoose', family: 'be-orm', rarity: 1.2 },
  { name: 'Drizzle ORM', aliases: ['drizzle'], family: 'be-orm', rarity: 1.8 },

  // ── APIs & messaging ───────────────────────────────────────────────────────
  {
    name: 'REST API',
    aliases: ['rest', 'restful', 'restful api', 'rest apis'],
    family: 'api',
    rarity: 0.6,
  },
  { name: 'GraphQL', aliases: ['apollo', 'apollo server'], family: 'api', rarity: 1.3 },
  { name: 'gRPC', aliases: ['protobuf', 'protocol buffers'], family: 'api', rarity: 1.6 },
  {
    name: 'WebSocket',
    aliases: ['websockets', 'socket.io', 'socketio'],
    family: 'api',
    rarity: 1.3,
  },
  { name: 'tRPC', aliases: ['trpc'], family: 'api', rarity: 1.8 },
  { name: 'OpenAPI', aliases: ['swagger'], family: 'api', rarity: 1.2 },
  { name: 'Kafka', aliases: ['apache kafka'], family: 'messaging', rarity: 1.5 },
  { name: 'RabbitMQ', aliases: ['amqp'], family: 'messaging', rarity: 1.5 },
  { name: 'SQS', aliases: ['amazon sqs'], family: 'messaging', rarity: 1.4 },
  { name: 'Pub/Sub', aliases: ['pubsub', 'google pub/sub'], family: 'messaging', rarity: 1.5 },
  { name: 'NATS', family: 'messaging', rarity: 1.9 },
  { name: 'Temporal', aliases: ['temporal.io'], family: 'be-async', rarity: 1.9 },
  { name: 'Microservices', aliases: ['microservice architecture'], family: 'arch', rarity: 1.0 },
  {
    name: 'Event-Driven Architecture',
    aliases: ['event driven', 'eda'],
    family: 'arch',
    rarity: 1.5,
  },
  {
    name: 'Domain-Driven Design',
    aliases: ['ddd', 'domain driven design'],
    family: 'arch',
    rarity: 1.6,
  },
  { name: 'System Design', aliases: ['distributed systems'], family: 'arch', rarity: 1.3 },
  { name: 'Serverless', aliases: ['faas'], family: 'arch', rarity: 1.3 },

  // ── Data stores ────────────────────────────────────────────────────────────
  { name: 'PostgreSQL', aliases: ['postgres', 'psql'], family: 'db-relational', rarity: 0.9 },
  { name: 'MySQL', aliases: ['mariadb'], family: 'db-relational', rarity: 0.8 },
  {
    name: 'SQL Server',
    aliases: ['mssql', 'microsoft sql server'],
    family: 'db-relational',
    rarity: 1.2,
  },
  { name: 'Oracle DB', aliases: ['oracle database'], family: 'db-relational', rarity: 1.3 },
  { name: 'SQLite', family: 'db-relational', rarity: 1.2 },
  { name: 'MongoDB', aliases: ['mongo'], family: 'db-document', rarity: 0.9 },
  { name: 'DynamoDB', family: 'db-document', rarity: 1.4 },
  { name: 'Cassandra', family: 'db-wide-column', rarity: 1.7 },
  { name: 'Redis', family: 'db-cache', rarity: 1.1 },
  { name: 'Memcached', family: 'db-cache', rarity: 1.6 },
  {
    name: 'Elasticsearch',
    aliases: ['elastic search', 'opensearch', 'elk'],
    family: 'db-search',
    rarity: 1.4,
  },
  { name: 'Neo4j', family: 'db-graph', rarity: 1.8 },
  { name: 'ClickHouse', family: 'db-analytics', rarity: 1.8 },
  { name: 'Snowflake', family: 'db-analytics', rarity: 1.5 },
  { name: 'BigQuery', family: 'db-analytics', rarity: 1.5 },
  { name: 'Redshift', family: 'db-analytics', rarity: 1.5 },
  { name: 'Firebase', aliases: ['firestore'], family: 'baas', rarity: 1.2 },
  { name: 'Supabase', family: 'baas', rarity: 1.7 },

  // ── Cloud & infra ──────────────────────────────────────────────────────────
  { name: 'AWS', aliases: ['amazon web services'], family: 'cloud', rarity: 0.8 },
  { name: 'Azure', aliases: ['microsoft azure'], family: 'cloud', rarity: 1.0 },
  { name: 'GCP', aliases: ['google cloud', 'google cloud platform'], family: 'cloud', rarity: 1.1 },
  { name: 'Lambda', aliases: ['aws lambda'], family: 'cloud', rarity: 1.3 },
  { name: 'EC2', family: 'cloud', rarity: 1.2 },
  { name: 'S3', aliases: ['amazon s3'], family: 'cloud', rarity: 1.1 },
  { name: 'ECS', aliases: ['amazon ecs', 'fargate'], family: 'cloud', rarity: 1.5 },
  { name: 'CloudFormation', family: 'iac', rarity: 1.6 },
  { name: 'Docker', aliases: ['containerization', 'containers'], family: 'container', rarity: 0.9 },
  { name: 'Kubernetes', aliases: ['k8s', 'eks', 'aks', 'gke'], family: 'container', rarity: 1.4 },
  { name: 'Helm', family: 'container', rarity: 1.7 },
  { name: 'Terraform', family: 'iac', rarity: 1.5 },
  { name: 'Pulumi', family: 'iac', rarity: 1.9 },
  { name: 'Ansible', family: 'iac', rarity: 1.6 },
  { name: 'Nginx', family: 'ops', rarity: 1.1 },
  { name: 'Linux', aliases: ['unix'], family: 'ops', rarity: 0.8 },
  {
    name: 'CI/CD',
    aliases: ['ci cd', 'continuous integration', 'continuous delivery'],
    family: 'devops',
    rarity: 0.8,
  },
  { name: 'GitHub Actions', family: 'devops', rarity: 1.3 },
  { name: 'Jenkins', family: 'devops', rarity: 1.2 },
  { name: 'GitLab CI', aliases: ['gitlab ci/cd'], family: 'devops', rarity: 1.4 },
  { name: 'CircleCI', family: 'devops', rarity: 1.6 },
  { name: 'ArgoCD', aliases: ['argo cd', 'gitops'], family: 'devops', rarity: 1.8 },
  { name: 'Git', aliases: ['version control'], family: 'devops', rarity: 0.5 },
  { name: 'Prometheus', family: 'observability', rarity: 1.6 },
  { name: 'Grafana', family: 'observability', rarity: 1.5 },
  { name: 'Datadog', family: 'observability', rarity: 1.5 },
  { name: 'Sentry', family: 'observability', rarity: 1.4 },
  { name: 'OpenTelemetry', aliases: ['otel'], family: 'observability', rarity: 1.8 },
  { name: 'New Relic', family: 'observability', rarity: 1.6 },

  // ── Testing & quality ──────────────────────────────────────────────────────
  { name: 'Jest', family: 'testing', rarity: 1.0 },
  { name: 'Vitest', family: 'testing', rarity: 1.5 },
  { name: 'Mocha', aliases: ['chai'], family: 'testing', rarity: 1.3 },
  { name: 'Cypress', family: 'testing', rarity: 1.3 },
  { name: 'Playwright', family: 'testing', rarity: 1.5 },
  { name: 'Selenium', family: 'testing', rarity: 1.3 },
  { name: 'JUnit', family: 'testing', rarity: 1.2 },
  { name: 'PyTest', aliases: ['pytest'], family: 'testing', rarity: 1.3 },
  {
    name: 'Testing Library',
    aliases: ['react testing library', 'rtl'],
    family: 'testing',
    rarity: 1.3,
  },
  {
    name: 'TDD',
    aliases: ['test driven development', 'test-driven'],
    family: 'testing',
    rarity: 1.2,
  },
  { name: 'Unit Testing', aliases: ['unit tests'], family: 'testing', rarity: 0.7 },

  // ── Mobile ─────────────────────────────────────────────────────────────────
  { name: 'React Native', family: 'mobile', rarity: 1.4 },
  { name: 'Flutter', family: 'mobile', rarity: 1.5 },
  { name: 'Android', aliases: ['android sdk'], family: 'mobile', rarity: 1.2 },
  { name: 'iOS', aliases: ['swiftui', 'uikit'], family: 'mobile', rarity: 1.3 },
  { name: 'Expo', family: 'mobile', rarity: 1.7 },

  // ── Data / ML / AI ─────────────────────────────────────────────────────────
  { name: 'Machine Learning', aliases: ['ml'], family: 'ml', rarity: 1.3 },
  { name: 'Deep Learning', family: 'ml', rarity: 1.5 },
  { name: 'PyTorch', family: 'ml', rarity: 1.6 },
  { name: 'TensorFlow', family: 'ml', rarity: 1.6 },
  { name: 'scikit-learn', aliases: ['sklearn', 'scikit learn'], family: 'ml', rarity: 1.5 },
  { name: 'Pandas', family: 'data', rarity: 1.2 },
  { name: 'NumPy', family: 'data', rarity: 1.2 },
  {
    name: 'Spark',
    aliases: ['apache spark', 'pyspark'],
    family: 'data',
    rarity: 1.6,
    needsContext: true,
  },
  { name: 'Airflow', aliases: ['apache airflow'], family: 'data', rarity: 1.6 },
  { name: 'dbt', family: 'data', rarity: 1.8 },
  { name: 'ETL', aliases: ['elt', 'data pipeline', 'data pipelines'], family: 'data', rarity: 1.1 },
  {
    name: 'LLM',
    aliases: ['large language model', 'large language models'],
    family: 'ai',
    rarity: 1.6,
  },
  {
    name: 'RAG',
    aliases: ['retrieval augmented generation', 'retrieval-augmented'],
    family: 'ai',
    rarity: 1.8,
  },
  { name: 'LangChain', family: 'ai', rarity: 1.8 },
  { name: 'OpenAI API', aliases: ['openai', 'gpt-4', 'chatgpt api'], family: 'ai', rarity: 1.5 },
  {
    name: 'Vector Database',
    aliases: ['pinecone', 'weaviate', 'pgvector', 'vector db'],
    family: 'ai',
    rarity: 1.8,
  },
  { name: 'Prompt Engineering', family: 'ai', rarity: 1.6 },

  // ── Security & auth ────────────────────────────────────────────────────────
  { name: 'JWT', aliases: ['json web token'], family: 'auth', rarity: 1.0 },
  {
    name: 'OAuth',
    aliases: ['oauth2', 'oauth 2.0', 'openid connect', 'oidc'],
    family: 'auth',
    rarity: 1.2,
  },
  { name: 'SAML', family: 'auth', rarity: 1.7 },
  { name: 'Auth0', family: 'auth', rarity: 1.5 },
  { name: 'Keycloak', family: 'auth', rarity: 1.7 },
  { name: 'OWASP', aliases: ['application security', 'appsec'], family: 'security', rarity: 1.5 },
  {
    name: 'Penetration Testing',
    aliases: ['pentesting', 'pen testing'],
    family: 'security',
    rarity: 1.7,
  },

  // ── CMS / commerce / enterprise ────────────────────────────────────────────
  { name: 'AEM', aliases: ['adobe experience manager'], family: 'cms', rarity: 1.7 },
  { name: 'Contentful', family: 'cms', rarity: 1.6 },
  { name: 'Sanity', family: 'cms', rarity: 1.7 },
  { name: 'Strapi', family: 'cms', rarity: 1.7 },
  { name: 'WordPress', family: 'cms', rarity: 1.1 },
  { name: 'Shopify', family: 'commerce', rarity: 1.5 },
  { name: 'Salesforce', aliases: ['apex', 'lwc'], family: 'enterprise', rarity: 1.4 },
  { name: 'SAP', family: 'enterprise', rarity: 1.5 },
  { name: 'Stripe', family: 'payments', rarity: 1.4 },
  { name: 'Razorpay', family: 'payments', rarity: 1.6 },
  { name: 'Twilio', family: 'comms', rarity: 1.5 },

  // ── Web3 ───────────────────────────────────────────────────────────────────
  { name: 'Web3.js', aliases: ['web3', 'ethers.js', 'ethersjs'], family: 'web3', rarity: 1.8 },
  { name: 'Blockchain', aliases: ['ethereum', 'smart contracts'], family: 'web3', rarity: 1.7 },

  // ── Ways of working ────────────────────────────────────────────────────────
  {
    name: 'Agile',
    aliases: ['scrum', 'kanban', 'sprint planning'],
    family: 'process',
    rarity: 0.6,
  },
  { name: 'Code Review', aliases: ['peer review'], family: 'process', rarity: 0.7 },
  { name: 'Jira', aliases: ['confluence'], family: 'process', rarity: 0.6 },
  { name: 'Mentoring', aliases: ['mentorship', 'coaching'], family: 'leadership', rarity: 1.2 },
  {
    name: 'Technical Leadership',
    aliases: ['tech lead', 'team lead'],
    family: 'leadership',
    rarity: 1.3,
  },
  { name: 'Figma', family: 'design', rarity: 1.1 },
];

export const SKILLS: readonly SkillDef[] = defs;

/** Canonical names, sorted — used for the profile form's skill autocomplete. */
export const SKILL_NAMES: readonly string[] = defs
  .map((d) => d.name)
  .sort((a, b) => a.localeCompare(b));

/** lowercase alias (and canonical name) → canonical name. */
const aliasToCanonical = new Map<string, string>();
const byName = new Map<string, SkillDef>();
for (const def of defs) {
  byName.set(def.name.toLowerCase(), def);
  aliasToCanonical.set(def.name.toLowerCase(), def.name);
  for (const alias of def.aliases ?? []) {
    aliasToCanonical.set(alias.toLowerCase(), def.name);
  }
}

/** Precompiled matchers, built once at module load rather than per job. */
interface Matcher {
  canonical: string;
  re: RegExp;
  needsContext: boolean;
}

const matchers: Matcher[] = defs.flatMap((def) => {
  const forms = [def.name, ...(def.aliases ?? [])];
  return forms.map((form) => ({
    canonical: def.name,
    re: buildFormRegex(form),
    needsContext: def.needsContext === true,
  }));
});

/**
 * Word boundaries that survive punctuation-bearing names. `\b` is useless here:
 * it fires in the middle of "C++" and refuses to fire before ".NET". Excluding
 * `+` and `#` from the trailing class is what stops the bare "C" matcher from
 * claiming a hit inside "C++" or "C#". And "react" still won't match "reactive".
 */
function buildFormRegex(form: string): RegExp {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9+#])`, 'gi');
}

/**
 * Ambiguous names ("Go", "C", "R", "Scala") only count when the surrounding text
 * makes the reading unambiguous. Without this, every JD containing "go to
 * market" would claim the candidate needs Golang — and that single false
 * positive is enough to push an irrelevant listing over the match threshold.
 *
 * Three accepted shapes, all observed in real postings:
 *   1. inside a delimited list      "Languages: Java, Go, Rust"
 *   2. followed by a role/tech noun "a Go developer" · "Go microservices"
 *   3. after a lead-in preposition, and then closed off
 *                                    "written in Go" · "experience with Go and k8s"
 */
const LIST_BEFORE = /(?:^|[,;/|•·\n\t([])[ \t]*$/;
const LIST_AFTER = /^[ \t]*(?:[,;/|•·)\]\n]|$)/;
const STRONG_AFTER =
  /^[ \t]+(?:developer|developers|engineer|engineers|programming|programmer|language|languages|lang|dev|devs|backend|frontend|services?|microservices?|expert|experience|expertise|codebase|stack|ecosystem|runtime|modules?|applications?)\b/i;
const LEAD_IN = /\b(?:in|with|using|via|on|knowledge of|proficiency in|experience in)[ \t]+$/i;
const WEAK_AFTER = /^[ \t]*(?:[,;/|•·)\]\n]|and\b|or\b|$)/i;

function hasListContext(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 32), start);
  const after = text.slice(end, end + 32);
  if (LIST_BEFORE.test(before) && LIST_AFTER.test(after)) return true;
  if (STRONG_AFTER.test(after)) return true;
  return LEAD_IN.test(before) && WEAK_AFTER.test(after);
}

/**
 * Map any spelling of a skill to its canonical name. Returns null when the input
 * isn't a skill we know, so callers can decide whether to keep it as free text
 * (the profile form does; the matcher doesn't).
 */
export function normalizeSkill(input: string): string | null {
  const key = input.trim().toLowerCase();
  if (!key) return null;
  return aliasToCanonical.get(key) ?? null;
}

/** Canonicalise a user-entered list, dropping duplicates but keeping unknowns. */
export function normalizeSkillList(inputs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of inputs) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const canonical = normalizeSkill(trimmed) ?? trimmed;
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

/** Every canonical skill mentioned in `text`, in taxonomy order. */
export function extractSkills(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const m of matchers) {
    m.re.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = m.re.exec(text)) !== null) {
      if (!m.needsContext || hasListContext(text, hit.index, hit.index + hit[0].length)) {
        found.add(m.canonical);
        break;
      }
    }
  }
  return defs.filter((d) => found.has(d.name)).map((d) => d.name);
}

/** Same as extractSkills, but reports where each skill was first seen. */
export function extractSkillsWithOffsets(text: string): { skill: string; index: number }[] {
  if (!text) return [];
  const first = new Map<string, number>();
  for (const m of matchers) {
    m.re.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = m.re.exec(text)) !== null) {
      if (!m.needsContext || hasListContext(text, hit.index, hit.index + hit[0].length)) {
        const prev = first.get(m.canonical);
        if (prev === undefined || hit.index < prev) first.set(m.canonical, hit.index);
        break;
      }
    }
  }
  return [...first.entries()]
    .map(([skill, index]) => ({ skill, index }))
    .sort((a, b) => a.index - b.index);
}

/**
 * Rarity weight, used as an IDF proxy so a JD's demand for Temporal counts for
 * more than its demand for JavaScript. Unknown skills get a mid weight rather
 * than being ignored — a skill we don't recognise is more likely niche.
 */
export function skillRarity(skill: string): number {
  return byName.get(skill.toLowerCase())?.rarity ?? 1.3;
}

export function skillFamily(skill: string): string | null {
  return byName.get(skill.toLowerCase())?.family ?? null;
}

/**
 * Partial credit for an adjacent skill. Vue experience is real evidence for a
 * React role, so the engine gives it 40% rather than zero — but never full
 * marks, because it isn't the same skill.
 */
export const FAMILY_CREDIT = 0.4;

/** True when two different skills sit in the same family. */
export function isRelatedSkill(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return false;
  const fa = skillFamily(a);
  return fa !== null && fa === skillFamily(b);
}
