import {ConfigurationError} from '@agent-foreman/core';

import {
  ConfigDocumentSchema,
  type ConfigDocument,
  type ConfigSources,
  type ProfileRole,
  type ResolvedConfig,
} from './schema.js';

const defaults = {
  general: {uiLanguage: 'auto', telemetry: false, logLevel: 'info' as const},
  workspace: {mode: 'smart' as const, preserveOnFailure: true, preserveOnPause: true},
  planning: {
    requireExplicitApproval: true,
    allowRepositoryRead: true,
    allowBaselineChecks: true,
    networkAccess: false,
  },
  workflow: {
    maxWorkerIterations: 8,
    maxMechanicalRepairs: 3,
    maxSupervisorReviews: 5,
    maxSameFindingOccurrences: 2,
    pauseOnNoProgressIterations: 2,
    detectDiffOscillation: true,
  },
  quality: {
    requireSupervisorApproval: true,
    maximumOpenCritical: 0,
    maximumOpenHigh: 0,
    allowOpenMedium: true,
    allowOpenLow: true,
    gates: [],
  },
} as const;

const safeDefaultProfiles: Readonly<
  Record<string, {supervisor: ProfileRole; worker: ProfileRole}>
> = {
  balanced: {
    supervisor: {provider: 'codex-cli'},
    worker: {provider: 'gemini-cli'},
  },
};

const parseOptionalDocument = (document: ConfigDocument | undefined): ConfigDocument | undefined =>
  document === undefined ? undefined : ConfigDocumentSchema.parse(document);

const overrideRole = (
  role: ProfileRole,
  provider: string | undefined,
  model: string | undefined,
): ProfileRole => {
  const resolved: ProfileRole = {...role};
  if (provider !== undefined) resolved.provider = provider;
  if (model !== undefined) resolved.model = model;
  return resolved;
};

export const resolveConfig = (sources: ConfigSources): ResolvedConfig => {
  const global = parseOptionalDocument(sources.global);
  const project = parseOptionalDocument(sources.project);
  const profiles = {...safeDefaultProfiles, ...global?.profiles, ...project?.profiles};
  const activeProfile =
    sources.cli?.profileName ?? project?.activeProfile ?? global?.activeProfile ?? 'balanced';
  const profile = profiles[activeProfile];
  if (profile === undefined) {
    throw new ConfigurationError(`Active profile ${activeProfile} does not exist.`, {
      diagnostics: {activeProfile, availableProfiles: Object.keys(profiles)},
    });
  }

  return {
    version: 1,
    activeProfile,
    general: {
      uiLanguage:
        project?.general?.uiLanguage ?? global?.general?.uiLanguage ?? defaults.general.uiLanguage,
      telemetry:
        project?.general?.telemetry ?? global?.general?.telemetry ?? defaults.general.telemetry,
      logLevel:
        project?.general?.logLevel ?? global?.general?.logLevel ?? defaults.general.logLevel,
    },
    workspace: {
      mode: project?.workspace?.mode ?? global?.workspace?.mode ?? defaults.workspace.mode,
      preserveOnFailure:
        project?.workspace?.preserveOnFailure ??
        global?.workspace?.preserveOnFailure ??
        defaults.workspace.preserveOnFailure,
      preserveOnPause:
        project?.workspace?.preserveOnPause ??
        global?.workspace?.preserveOnPause ??
        defaults.workspace.preserveOnPause,
    },
    planning: {
      requireExplicitApproval:
        project?.planning?.requireExplicitApproval ??
        global?.planning?.requireExplicitApproval ??
        defaults.planning.requireExplicitApproval,
      allowRepositoryRead:
        project?.planning?.allowRepositoryRead ??
        global?.planning?.allowRepositoryRead ??
        defaults.planning.allowRepositoryRead,
      allowBaselineChecks:
        project?.planning?.allowBaselineChecks ??
        global?.planning?.allowBaselineChecks ??
        defaults.planning.allowBaselineChecks,
      networkAccess:
        project?.planning?.networkAccess ??
        global?.planning?.networkAccess ??
        defaults.planning.networkAccess,
    },
    workflow: {
      maxWorkerIterations:
        project?.workflow?.maxWorkerIterations ??
        global?.workflow?.maxWorkerIterations ??
        defaults.workflow.maxWorkerIterations,
      maxMechanicalRepairs:
        project?.workflow?.maxMechanicalRepairs ??
        global?.workflow?.maxMechanicalRepairs ??
        defaults.workflow.maxMechanicalRepairs,
      maxSupervisorReviews:
        project?.workflow?.maxSupervisorReviews ??
        global?.workflow?.maxSupervisorReviews ??
        defaults.workflow.maxSupervisorReviews,
      maxSameFindingOccurrences:
        project?.workflow?.maxSameFindingOccurrences ??
        global?.workflow?.maxSameFindingOccurrences ??
        defaults.workflow.maxSameFindingOccurrences,
      pauseOnNoProgressIterations:
        project?.workflow?.pauseOnNoProgressIterations ??
        global?.workflow?.pauseOnNoProgressIterations ??
        defaults.workflow.pauseOnNoProgressIterations,
      detectDiffOscillation:
        project?.workflow?.detectDiffOscillation ??
        global?.workflow?.detectDiffOscillation ??
        defaults.workflow.detectDiffOscillation,
    },
    quality: {
      requireSupervisorApproval:
        project?.quality?.requireSupervisorApproval ??
        global?.quality?.requireSupervisorApproval ??
        defaults.quality.requireSupervisorApproval,
      maximumOpenCritical:
        project?.quality?.maximumOpenCritical ??
        global?.quality?.maximumOpenCritical ??
        defaults.quality.maximumOpenCritical,
      maximumOpenHigh:
        project?.quality?.maximumOpenHigh ??
        global?.quality?.maximumOpenHigh ??
        defaults.quality.maximumOpenHigh,
      allowOpenMedium:
        project?.quality?.allowOpenMedium ??
        global?.quality?.allowOpenMedium ??
        defaults.quality.allowOpenMedium,
      allowOpenLow:
        project?.quality?.allowOpenLow ??
        global?.quality?.allowOpenLow ??
        defaults.quality.allowOpenLow,
      gates: project?.quality?.gates ?? global?.quality?.gates ?? defaults.quality.gates,
    },
    supervisor: overrideRole(
      profile.supervisor,
      sources.cli?.supervisorProvider,
      sources.cli?.supervisorModel,
    ),
    worker: overrideRole(profile.worker, sources.cli?.workerProvider, sources.cli?.workerModel),
    providers: {...global?.providers, ...project?.providers},
  };
};
