import { describe, expect, it } from 'vitest';
import {
  type ModelConfig,
  type ProjectModelConfig,
  MODEL_ROLES,
  SUPPORTED_MODEL_PROVIDERS,
  resolveModelForRole,
} from '../src/types.js';

describe('Model Configuration & Roles', () => {
  it('enforces Nebius as the only supported provider for hackathon', () => {
    expect(SUPPORTED_MODEL_PROVIDERS).toEqual(['nebius']);
  });

  it('defines the canonical agent roles', () => {
    expect(MODEL_ROLES).toEqual([
      'planner',
      'builder',
      'reviewer',
      'repairer',
      'summarizer',
    ]);
  });

  it('validates a proper Nebius model configuration', () => {
    const config: ModelConfig = {
      provider: 'nebius',
      model: 'nvidia/nemotron-4-340b-instruct',
      inferenceConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxTokens: 4096,
        seed: 42,
      },
    };

    expect(config.provider).toBe('nebius');
    expect(config.model).toBe('nvidia/nemotron-4-340b-instruct');
    expect(config.inferenceConfig?.seed).toBe(42);
  });

  it('resolves role-specific configuration when present', () => {
    const projectConfig: ProjectModelConfig = {
      defaultModel: {
        provider: 'nebius',
        model: 'nvidia/nemotron-4-340b-instruct',
        inferenceConfig: { temperature: 0.2 },
      },
      roles: {
        builder: {
          provider: 'nebius',
          model: 'meta-llama/Llama-3.3-70B-Instruct',
          inferenceConfig: { temperature: 0.1 },
        },
        reviewer: {
          provider: 'nebius',
          model: 'Qwen/Qwen2.5-Coder-32B-Instruct',
          inferenceConfig: { temperature: 0.0 },
        },
      },
    };

    const builderConfig = resolveModelForRole(projectConfig, 'builder');
    expect(builderConfig.model).toBe('meta-llama/Llama-3.3-70B-Instruct');
    expect(builderConfig.inferenceConfig?.temperature).toBe(0.1);

    const reviewerConfig = resolveModelForRole(projectConfig, 'reviewer');
    expect(reviewerConfig.model).toBe('Qwen/Qwen2.5-Coder-32B-Instruct');
    expect(reviewerConfig.inferenceConfig?.temperature).toBe(0.0);
  });

  it('falls back to defaultModel when role is unconfigured or omitted', () => {
    const projectConfig: ProjectModelConfig = {
      defaultModel: {
        provider: 'nebius',
        model: 'nvidia/nemotron-4-340b-instruct',
      },
      roles: {
        builder: {
          provider: 'nebius',
          model: 'meta-llama/Llama-3.3-70B-Instruct',
        },
      },
    };

    // Unconfigured role falls back to default
    const plannerConfig = resolveModelForRole(projectConfig, 'planner');
    expect(plannerConfig.model).toBe('nvidia/nemotron-4-340b-instruct');

    const repairerConfig = resolveModelForRole(projectConfig, 'repairer');
    expect(repairerConfig.model).toBe('nvidia/nemotron-4-340b-instruct');

    // Omitted role falls back to default
    const fallbackConfig = resolveModelForRole(projectConfig);
    expect(fallbackConfig.model).toBe('nvidia/nemotron-4-340b-instruct');
  });

  it('ensures model configuration objects do not store or leak API keys', () => {
    const projectConfig: ProjectModelConfig = {
      defaultModel: {
        provider: 'nebius',
        model: 'nvidia/nemotron-4-340b-instruct',
        inferenceConfig: { temperature: 0.2 },
      },
      roles: {
        planner: {
          provider: 'nebius',
          model: 'meta-llama/Llama-3.3-70B-Instruct',
        },
      },
    };

    const serialized = JSON.stringify(projectConfig);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('token');
  });
});
