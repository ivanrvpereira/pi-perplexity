export interface ModelOption {
  value: string;
  label: string;
}

export const KNOWN_MODELS: ModelOption[] = [
  { value: "pplx_pro_upgraded", label: "Pro (auto)" },
  { value: "pplx_pro", label: "Best (auto)" },
  { value: "experimental", label: "Sonar" },
  { value: "pplx_reasoning", label: "Reasoning" },
  { value: "pplx_alpha", label: "Deep Research" },
  { value: "gpt54", label: "GPT-5.4" },
  { value: "gpt54_thinking", label: "GPT-5.4 Thinking" },
  { value: "gpt52", label: "GPT-5.2" },
  { value: "gpt52_thinking", label: "GPT-5.2 Thinking" },
  { value: "gpt52_pro", label: "GPT-5.2 Pro" },
  { value: "gpt51", label: "GPT-5.1" },
  { value: "gpt51_thinking", label: "GPT-5.1 Thinking" },
  { value: "claude50sonnet", label: "Claude Sonnet 5" },
  { value: "claude50sonnetthinking", label: "Claude Sonnet 5 Thinking" },
  { value: "claude46sonnet", label: "Claude 4.6 Sonnet" },
  { value: "claude46sonnetthinking", label: "Claude 4.6 Sonnet Thinking" },
  { value: "claude47opus", label: "Claude 4.7 Opus" },
  { value: "claude47opusthinking", label: "Claude 4.7 Opus Thinking" },
  { value: "claude45sonnet", label: "Claude 4.5 Sonnet" },
  { value: "claude45sonnetthinking", label: "Claude 4.5 Sonnet Thinking" },
  { value: "gemini31pro_low", label: "Gemini 3.1 Pro" },
  { value: "gemini31pro_high", label: "Gemini 3.1 Pro Thinking" },
  { value: "gemini30pro", label: "Gemini 3 Pro" },
  { value: "gemini30flash", label: "Gemini 3 Flash" },
  { value: "gemini30flash_high", label: "Gemini 3 Flash Thinking" },
  { value: "grok41nonreasoning", label: "Grok 4.1" },
  { value: "grok41reasoning", label: "Grok 4.1 Reasoning" },
  { value: "grok4nonthinking", label: "Grok 4" },
  { value: "grok4", label: "Grok 4 Thinking" },
  { value: "nv_nemotron_3_super", label: "Nemotron 3 Super" },
  { value: "kimik25thinking", label: "Kimi K2.5 Thinking" },
];
