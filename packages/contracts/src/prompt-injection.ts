// Prompt Injection Detection Contracts — P1-2 Stage E.
//
// Defines the shared types for detecting and reporting prompt-injection
// attacks in tool arguments, model output, or user-supplied content.
//
// A prompt-injection attack tries to override the agent's system
// instructions by embedding directives in otherwise benign content.
// The runtime scans tool arguments and assistant messages before
// execution and can escalate risk to 'critical' / block the call.

export interface PromptInjectionMatch {
  /** Category of the detected attack. */
  type: PromptInjectionType;
  /** Substring that triggered the detector. */
  snippet: string;
  /** 0..1 confidence score. */
  confidence: number;
  /** Human-readable explanation. */
  reason: string;
}

export type PromptInjectionType =
  | 'ignore-previous'
  | 'system-prompt-leak'
  | 'role-confusion'
  | 'jailbreak'
  | 'instruction-override'
  | 'delimiter-break'
  | 'hidden-injection'
  | 'encoding-obfuscation';

export interface PromptInjectionReport {
  /** True if at least one match exceeded the block threshold. */
  injected: boolean;
  /** Highest confidence across all matches. */
  maxConfidence: number;
  /** All matches found. */
  matches: PromptInjectionMatch[];
  /** Normalized text that was scanned. */
  scannedText: string;
}

export interface PromptInjectionRule {
  /** Human-readable id for the rule. */
  id: string;
  /** Category this rule reports. */
  type: PromptInjectionType;
  /** Detection pattern: regex or heuristic name. */
  pattern: RegExp | string;
  /** Confidence score for matches of this rule. */
  confidence: number;
  /** Human-readable explanation template. */
  reason: string;
}

export interface PromptInjectionDetectorOptions {
  /**
   * Confidence threshold above which a match is considered injected.
   * Default: 0.6
   */
  blockThreshold?: number;
  /**
   * Additional custom rules. Added to the default rule set.
   */
  extraRules?: PromptInjectionRule[];
  /**
   * If true, decoded URL/hex/base64 obfuscation before scanning.
   * Default: true
   */
  decodeObfuscation?: boolean;
}

/**
 * Adapter that scans text for prompt-injection patterns.
 */
export interface IPromptInjectionDetector {
  /** Scan text and return a report. */
  scan(text: string): PromptInjectionReport;
  /** Scan a tool argument record (recursively stringifies values). */
  scanArgs(args: Record<string, unknown>): PromptInjectionReport;
}
