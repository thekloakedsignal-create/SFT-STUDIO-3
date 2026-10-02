export enum PresetType {
  GENERAL_USE = "General Use AI",
  COMPANION = "Companion AI",
  PERSONA = "Persona AI",
  RESEARCH = "Research AI",
  CUSTOM = "Custom AI",
}

export enum ProjectFormat {
  CONVERSATION = "Conversation",
  INSTRUCTION = "Instruction",
}

export enum TemplateType {
  SINGLE_TURN = "Single Turn",
  MULTI_TURN = "Multi Turn",
  REASONING = "Reasoning",
  INSTRUCTION_TEMPLATE = "Instruction Template",
  MIXED = "Mixed",
}

export enum InstructTemplate {
  MISTRAL = "Mistral",
  ALPACA = "Alpaca",
  CHATML = "ChatML",
}

export interface SFTMessage {
  role: string;
  content: string;
  reasoning?: string;
  reasoning_content?: string;
}

export interface SFTExample {
  id?: string;
  messages: SFTMessage[];
}

export interface ProjectSettings {
  name: string;
  systemPrompt: string;
  targetTask: string;
  constraints: string;
  selectedPreset: PresetType;
  projectFormat?: ProjectFormat;
  templateType?: TemplateType;
  instructTemplate?: InstructTemplate | "Mistral" | "Alpaca" | "ChatML";
  customInstructionFormat?: string;
  representativePrompt?: string;
  representativeCompletion?: string;
}

export interface SFTBatch {
  id: string;
  batchId?: string;
  name: string;
  source: "Generator" | "Doc Conversion" | "TRiAD Alignment" | "Dataset Import";
  templateType: TemplateType;
  examplesCount: number;
  examples: SFTExample[];
  status: "Pending" | "Approved" | "Rejected";
  timestamp: string;
  description?: string;
  specialInstructions?: string;
  temporaryConstraints?: string;
}

export interface QualityIssue {
  exampleIndex: number;
  severity: "High" | "Medium" | "Low";
  type: string;
  message: string;
}

export interface QualityReport {
  overallScore: number;
  stats: {
    totalExamples: number;
    passedCount: number;
    flaggedCount: number;
  };
  duplicateCheck: {
    duplicatesFound: number;
    duplicatesList: string[];
    deduplicatedLength: number;
  };
  issues: QualityIssue[];
  suggestions: string[];
}
