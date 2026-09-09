import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, seedLeads } from '../routes/routes.fixtures.js';

const runtime = vi.hoisted(() => ({
  tools: [] as { name: string; handler: (args: unknown) => Promise<unknown> }[],
  clicked: false,
  clientOptions: undefined as Record<string, unknown> | undefined,
  sessionOptions: undefined as Record<string, unknown> | undefined,
  updateOptions: vi.fn(),
  finish: undefined as (() => void) | undefined,
}));

vi.mock('@github/copilot-sdk', () => ({
  defineTool: (name: string, config: object) => ({ name, ...config }),
  RuntimeConnection: { forStdio: vi.fn() },
  ToolSet: class {
    addCustom() {
      return this;
    }
  },
  CopilotClient: class {
    constructor(options: Record<string, unknown>) {
      runtime.clientOptions = options;
    }
    start = vi.fn();
    stop = vi.fn().mockResolvedValue([]);
    forceStop = vi.fn(async () => runtime.finish?.());
    async createSession(config: { tools: typeof runtime.tools }) {
      runtime.tools = config.tools;
      runtime.sessionOptions = config;
      return {
        rpc: { options: { update: runtime.updateOptions } },
        sendAndWait: () =>
          new Promise<void>((resolve) => {
            runtime.finish = resolve;
          }),
        abort: async () => runtime.finish?.(),
      };
    }
  },
}));

vi.mock('./applicationBrowser.js', () => ({
  publicApplicationUrl: (url: string) => new URL(url),
  ApplicationBrowser: class {
    open = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    url = () => 'https://careers.example.com/apply';
    control = () => ({ label: 'Submit application', type: 'submit' });
    validateControl = vi.fn();
    text = async () =>
      runtime.clicked
        ? 'Your application has been submitted successfully.'
        : 'Review your application.';
    inspect = async () => ({ text: 'Review your application.' });
    click = async () => {
      runtime.clicked = true;
    };
    fill = vi.fn();
    upload = vi.fn();
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  runtime.clicked = false;
  runtime.tools = [];
  runtime.finish = undefined;
  runtime.clientOptions = undefined;
  runtime.sessionOptions = undefined;
  runtime.updateOptions.mockClear();
});

async function fixtureWithResume() {
  const fixture = await buildTestApp();
  seedLeads(fixture, [{ score: 0.9 }]);
  const repos = fixture.container.repos;
  const profile = repos.profiles.get()!;
  vi.spyOn(repos.profiles, 'get').mockReturnValue({ ...profile, resumeId: 'resume' });
  vi.spyOn(repos.resumes, 'get').mockReturnValue({
    id: 'resume',
    filename: 'resume.pdf',
    mimeType: 'application/pdf',
  } as NonNullable<ReturnType<typeof repos.resumes.get>>);
  vi.spyOn(repos.resumes, 'file').mockResolvedValue(new Uint8Array([1]));
  vi.spyOn(repos.resumes, 'text').mockReturnValue('Synthetic candidate resume.');
  vi.spyOn(fixture.container.applications, 'capability').mockResolvedValue({
    available: true,
    reason: null,
  });
  return fixture;
}

function tool(name: string, args: unknown) {
  const found = runtime.tools.find((entry) => entry.name === name);
  if (!found) throw new Error('Tool not registered.');
  return found.handler(args);
}

describe('application worker approvals', () => {
  it('preserves uncertainty when cancelled after a submit click', async () => {
    const fixture = await fixtureWithResume();
    try {
      const agent = fixture.container.applications;
      const lead = fixture.container.repos.leads.forProfile()[0]!;
      const run = await agent.start(lead.id, true, true);
      await vi.waitFor(() => expect(runtime.tools.length).toBe(6));
      expect(runtime.clientOptions).toMatchObject({
        mode: 'copilot-cli',
        useLoggedInUser: true,
      });
      expect(runtime.sessionOptions).toMatchObject({
        enableFileHooks: false,
        enableHostGitOperations: false,
        enableSkills: false,
        skipCustomInstructions: true,
        manageScheduleEnabled: false,
        includedBuiltinSkills: [],
        memory: { enabled: false },
        enableSessionStore: false,
      });
      await vi.waitFor(() =>
        expect(runtime.updateOptions).toHaveBeenCalledWith({ installedPlugins: [] }),
      );
      await tool('request_application_click', {
        ref: '1',
        summary: 'Send the completed application.',
        finalSubmission: true,
        requiresUserApproval: false,
      });
      await agent.cancel(run.id);
      expect(agent.runs.get(run.id)).toMatchObject({ status: 'failed', outcomeUnknown: true });
      expect(fixture.container.repos.leads.get(lead.id)?.status).toBe('new');
      expect(() => agent.runs.create(lead.id, run.updatedAt)).toThrow(/outcome is unknown/);
    } finally {
      await fixture.close();
    }
  });

  it('submits in explicitly authorized automatic mode but only marks applied after confirmation', async () => {
    const fixture = await fixtureWithResume();
    try {
      const agent = fixture.container.applications;
      const lead = fixture.container.repos.leads.forProfile()[0]!;
      const run = await agent.start(lead.id, true, true);
      await vi.waitFor(() => expect(runtime.tools.length).toBe(6));
      await tool('request_application_click', {
        ref: '1',
        summary: 'Send the completed application for this verified job.',
        finalSubmission: true,
        requiresUserApproval: false,
      });
      expect(runtime.clicked).toBe(true);
      expect(agent.runs.get(run.id)?.status).toBe('submitting');
      expect(fixture.container.repos.leads.get(lead.id)?.status).toBe('new');
      await tool('confirm_application', {
        confirmationText: 'Your application has been submitted successfully.',
      });
      expect(fixture.container.repos.leads.get(lead.id)?.status).toBe('applied');
      expect(
        agent.runs
          .get(run.id)
          ?.events.some((event) => event.message.includes('authorized automatic')),
      ).toBe(true);
      runtime.finish?.();
    } finally {
      await fixture.close();
    }
  });

  it('still pauses for account creation in automatic mode', async () => {
    const fixture = await fixtureWithResume();
    try {
      const agent = fixture.container.applications;
      const run = await agent.start(fixture.container.repos.leads.forProfile()[0]!.id, true, true);
      await vi.waitFor(() => expect(runtime.tools.length).toBe(6));
      const pending = tool('request_application_click', {
        ref: '1',
        summary: 'Create account.',
        finalSubmission: false,
        requiresUserApproval: false,
      });
      const rejected = expect(pending).rejects.toThrow(/cancelled/);
      await vi.waitFor(() => expect(agent.runs.get(run.id)?.status).toBe('needs_input'));
      expect(runtime.clicked).toBe(false);
      await agent.cancel(run.id);
      await rejected;
    } finally {
      await fixture.close();
    }
  });

  it('waits for single-use final approval and only marks applied after new visible confirmation', async () => {
    const fixture = await fixtureWithResume();
    try {
      const agent = fixture.container.applications;
      const lead = fixture.container.repos.leads.forProfile()[0]!;
      const run = await agent.start(lead.id, true);
      await vi.waitFor(() => expect(runtime.tools.length).toBe(6));
      await expect(agent.start(lead.id, true)).rejects.toThrow(/already active/);
      await expect(
        tool('confirm_application', {
          confirmationText: 'Your application has been submitted successfully.',
        }),
      ).rejects.toThrow(/No final/);
      const click = tool('request_application_click', {
        ref: '1',
        summary: 'Submit synthetic candidate to Example.',
        finalSubmission: true,
      });
      await vi.waitFor(() => expect(agent.runs.get(run.id)?.status).toBe('ready'));
      expect(runtime.clicked).toBe(false);
      expect(fixture.container.repos.leads.get(lead.id)?.status).toBe('new');
      const requestId = agent.runs.get(run.id)!.requestId!;
      expect(() => agent.respond(run.id, 'stale', 'Approved')).toThrow(/no longer active/);
      agent.respond(run.id, requestId, 'Approved');
      expect(() => agent.respond(run.id, requestId, 'Approved')).toThrow(/no longer active/);
      await click;
      expect(runtime.clicked).toBe(true);
      expect(fixture.container.repos.leads.get(lead.id)?.status).toBe('new');
      await tool('confirm_application', {
        confirmationText: 'Your application has been submitted successfully.',
      });
      expect(agent.runs.get(run.id)?.status).toBe('submitted');
      expect(fixture.container.repos.leads.get(lead.id)?.status).toBe('applied');
      runtime.finish?.();
    } finally {
      await fixture.close();
    }
  });

  it('cancels a pending action without clicking it', async () => {
    const fixture = await fixtureWithResume();
    try {
      const agent = fixture.container.applications;
      const run = await agent.start(fixture.container.repos.leads.forProfile()[0]!.id, true);
      await vi.waitFor(() => expect(runtime.tools.length).toBe(6));
      const click = tool('request_application_click', {
        ref: '1',
        summary: 'Create account.',
        finalSubmission: false,
      });
      const rejected = expect(click).rejects.toThrow(/cancelled/);
      await vi.waitFor(() => expect(agent.runs.get(run.id)?.status).toBe('needs_input'));
      await agent.cancel(run.id);
      await rejected;
      expect(runtime.clicked).toBe(false);
      expect(agent.runs.get(run.id)?.status).toBe('cancelled');
    } finally {
      await fixture.close();
    }
  });
});
