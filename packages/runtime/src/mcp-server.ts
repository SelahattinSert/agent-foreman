import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';

import {
  ApprovalChallengeSchema,
  AppliedChangesResultSchema,
  ApplyApprovalRequestSchema,
  ApplyApproveInputSchema,
  ApplyRequestInputSchema,
  NativeReviewPacketSchema,
  PlanApprovalRequestInputSchema,
  PlanApproveInputSchema,
  PlanSubmitInputSchema,
  SessionCreateInputSchema,
  TaskPlanSchema,
  TaskSessionSchema,
  WorkerStartInputSchema,
  RevisionSubmitInputSchema,
  RuntimeResumeInputSchema,
  RuntimeResumePacketSchema,
} from '@agent-foreman/contracts';
import {PermissionDeniedError} from '@agent-foreman/core';

import type {HeadlessRuntimeService} from './service.js';

export interface AgentForemanMcpServerOptions {
  readonly service: HeadlessRuntimeService;
}

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SubmittedPlanSchema = z.strictObject({
  session: TaskSessionSchema,
  planHash: Sha256Schema,
});
const ApprovedPlanSchema = z.strictObject({
  session: TaskSessionSchema,
  plan: TaskPlanSchema,
  approvedPlanHash: Sha256Schema,
});

const toolResult = (data: object): CallToolResult => ({
  content: [{type: 'text', text: JSON.stringify(data)}],
  structuredContent: data as Record<string, unknown>,
});

const closedWorldRead = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const closedWorldWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const createAgentForemanMcpServer = (options: AgentForemanMcpServerOptions): McpServer => {
  const server = new McpServer(
    {name: 'agent-foreman', version: '0.1.0'},
    {
      capabilities: {},
      instructions:
        'Use these tools only after the user explicitly invokes $agent-foreman. Native Codex owns conversation, repository discovery, planning, and review. The runtime owns durable state and authorization.',
    },
  );

  server.registerTool(
    'agent_foreman_session_create',
    {
      title: 'Create Agent Foreman session',
      description:
        'Create durable state for an explicitly invoked Agent Foreman task. This does not launch a supervisor or worker.',
      inputSchema: SessionCreateInputSchema,
      outputSchema: TaskSessionSchema,
      annotations: closedWorldWrite,
    },
    async (input) => toolResult({...(await options.service.sessionCreate(input))}),
  );

  server.registerTool(
    'agent_foreman_plan_submit',
    {
      title: 'Submit draft plan',
      description:
        'Store the native Codex draft plan and canonical hash. This never approves the plan or launches the worker.',
      inputSchema: PlanSubmitInputSchema,
      outputSchema: SubmittedPlanSchema,
      annotations: closedWorldWrite,
    },
    async (input) => toolResult({...(await options.service.planSubmit(input))}),
  );

  server.registerTool(
    'agent_foreman_plan_approval_request',
    {
      title: 'Request plan approval',
      description:
        'Create a short-lived, single-use approval challenge bound to the exact draft plan hash.',
      inputSchema: PlanApprovalRequestInputSchema,
      outputSchema: ApprovalChallengeSchema,
      annotations: closedWorldWrite,
    },
    async (input) => toolResult({...(await options.service.planApprovalRequest(input))}),
  );

  server.registerTool(
    'agent_foreman_plan_approve',
    {
      title: 'Confirm and freeze plan',
      description:
        'Ask the MCP client for explicit human confirmation, then consume the challenge and freeze the exact plan. Tool arguments alone cannot approve a plan.',
      inputSchema: PlanApproveInputSchema,
      outputSchema: ApprovedPlanSchema,
      annotations: closedWorldWrite,
    },
    async (input) => {
      const confirmation = await server.server.elicitInput({
        mode: 'form',
        message: `Approve and freeze Agent Foreman plan hash ${input.planHash}? The worker may start only after this confirmation.`,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              title: 'Approve plan',
              description: 'Confirm that you reviewed and approve this exact plan hash.',
              default: false,
            },
          },
          required: ['confirm'],
        },
      });
      if (confirmation.action !== 'accept' || confirmation.content?.confirm !== true) {
        throw new PermissionDeniedError('The user did not approve the plan.');
      }
      return toolResult({
        ...(await options.service.planApprove(input, {
          trusted: true,
          source: 'mcp-user-confirmation',
        })),
      });
    },
  );

  server.registerTool(
    'agent_foreman_worker_start',
    {
      title: 'Authorize worker start',
      description:
        'Validate the frozen plan, create the isolated workspace, run the configured worker and deterministic gates, and return a native-supervisor review packet.',
      inputSchema: WorkerStartInputSchema,
      outputSchema: NativeReviewPacketSchema,
      annotations: closedWorldWrite,
    },
    async (input) => toolResult({...(await options.service.workerStart(input))}),
  );

  server.registerTool(
    'agent_foreman_review_submit',
    {
      title: 'Submit native Codex review',
      description:
        'Persist a schema-valid native supervisor decision. Revisions run through the worker and gates; approvals advance semantic or final review.',
      inputSchema: RevisionSubmitInputSchema,
      outputSchema: NativeReviewPacketSchema,
      annotations: closedWorldWrite,
    },
    async (input) => toolResult({...(await options.service.reviewSubmit(input))}),
  );

  server.registerTool(
    'agent_foreman_apply_request',
    {
      title: 'Request apply approval',
      description:
        'Bind a short-lived apply challenge to the exact reviewed diff hash and unchanged source baseline.',
      inputSchema: ApplyRequestInputSchema,
      outputSchema: ApplyApprovalRequestSchema,
      annotations: closedWorldWrite,
    },
    async (input) => toolResult({...(await options.service.applyRequest(input))}),
  );

  server.registerTool(
    'agent_foreman_apply_approve',
    {
      title: 'Confirm and apply changes',
      description:
        'Ask the MCP client for explicit human apply confirmation, consume the single-use challenge, revalidate diff and baseline, then apply atomically.',
      inputSchema: ApplyApproveInputSchema,
      outputSchema: AppliedChangesResultSchema,
      annotations: {...closedWorldWrite, destructiveHint: true},
    },
    async (input) => {
      const confirmation = await server.server.elicitInput({
        mode: 'form',
        message: `Apply reviewed Agent Foreman diff ${input.reviewedDiffHash} to source baseline ${input.sourceBaseline}?`,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              title: 'Apply changes',
              description: 'Confirm this exact reviewed diff and source baseline.',
              default: false,
            },
          },
          required: ['confirm'],
        },
      });
      if (confirmation.action !== 'accept' || confirmation.content?.confirm !== true) {
        throw new PermissionDeniedError('The user did not approve applying the changes.');
      }
      return toolResult({
        ...(await options.service.applyApprove(input, {
          trusted: true,
          source: 'mcp-user-confirmation',
        })),
      });
    },
  );

  server.registerTool(
    'agent_foreman_resume',
    {
      title: 'Resume Agent Foreman session',
      description:
        'Reconstruct the next safe native-Codex action from SQLite, the approved plan hash, workspace, worker result, gates and findings. Potentially non-idempotent in-flight operations are paused instead of silently replayed.',
      inputSchema: RuntimeResumeInputSchema,
      outputSchema: RuntimeResumePacketSchema,
      annotations: closedWorldWrite,
    },
    async (input) => toolResult({...(await options.service.resume(input))}),
  );

  server.registerTool(
    'agent_foreman_status',
    {
      title: 'Read Agent Foreman status',
      description: 'Load the durable current state for an Agent Foreman session.',
      inputSchema: z.strictObject({sessionId: z.string().trim().min(1)}),
      outputSchema: TaskSessionSchema,
      annotations: closedWorldRead,
    },
    async (input) => toolResult({...(await options.service.status(input))}),
  );

  return server;
};
