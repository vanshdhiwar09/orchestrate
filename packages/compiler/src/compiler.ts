import { ContextCompilerCore } from './core.js';
import { ContextLoader, type ContextLoaderOptions } from './loader.js';
import { ContextSerializer } from './serializer.js';
import type { CompilationRequest, CompiledContext } from './types.js';

/**
 * High-level facade for compiling and serializing evidence-backed context
 * for downstream agent executions.
 */
export class ContextCompiler {
  private readonly loader: ContextLoader;

  constructor(options: ContextLoaderOptions) {
    this.loader = new ContextLoader(options);
  }

  /**
   * Loads the snapshot and compiles it deterministically into structured context.
   */
  public async compile(request: CompilationRequest): Promise<CompiledContext> {
    const snapshot = await this.loader.load(request);
    return ContextCompilerCore.compile(snapshot, request.config);
  }

  /**
   * Loads, compiles, and serializes the context into XML formatted string.
   */
  public async compileAndSerialize(request: CompilationRequest): Promise<string> {
    const compiled = await this.compile(request);
    return ContextSerializer.serialize(compiled);
  }
}
