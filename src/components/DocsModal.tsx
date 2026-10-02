import React from "react";
import { motion } from "motion/react";
import { X, BookOpen, Code, FileText, CheckCircle2, ExternalLink, HelpCircle } from "lucide-react";

interface DocsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DocsModal: React.FC<DocsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full p-6 shadow-2xl relative text-slate-200 my-8 max-h-[90vh] overflow-y-auto"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
            <BookOpen className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight">SFT Studio Pro Documentation & Guides</h2>
            <p className="text-xs text-slate-400">Dataset specifications, reasoning tag formatting, and export schemas</p>
          </div>
        </div>

        <div className="space-y-6 text-sm text-slate-300">
          {/* Format Guides */}
          <section className="space-y-3">
            <h3 className="text-white font-semibold text-base flex items-center gap-2 border-b border-slate-800 pb-2">
              <Code className="h-4 w-4 text-emerald-400" /> Supported Export Template Formats
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="bg-slate-950/70 p-3.5 rounded-xl border border-slate-800">
                <div className="font-bold text-blue-400 mb-1">1. ChatML Standard &amp; Token Format (&lt;|im_start|&gt;)</div>
                <p className="text-slate-400 mb-2">Standard JSONL message array or raw serialized token text with &lt;|im_start|&gt; and &lt;|im_end|&gt; tags compatible with ChatML tokenizers, Axolotl, and vLLM.</p>
                <div className="bg-slate-900 p-2 rounded text-[11px] font-mono text-slate-300 overflow-x-auto">
                  messages: [...] | text: "&lt;|im_start|&gt;system\n...&lt;|im_end|&gt;\n&lt;|im_start|&gt;user\n...&lt;|im_end|&gt;\n&lt;|im_start|&gt;assistant\n...&lt;|im_end|&gt;"
                </div>
              </div>

              <div className="bg-slate-950/70 p-3.5 rounded-xl border border-slate-800">
                <div className="font-bold text-emerald-400 mb-1">2. Stanford Alpaca Format</div>
                <p className="text-slate-400 mb-2">Canonical instruction tuning format organizing records into instruction, input context, and target output fields for Axolotl, LLaMA-Factory, and Unsloth.</p>
                <div className="bg-slate-900 p-2 rounded text-[11px] font-mono text-slate-300 overflow-x-auto">
                  &#123; instruction: "...", input: "...", output: "..." &#125;
                </div>
              </div>

              <div className="bg-slate-950/70 p-3.5 rounded-xl border border-slate-800">
                <div className="font-bold text-amber-400 mb-1">3. Mistral Instruction Format</div>
                <p className="text-slate-400 mb-2">Standardized multi-tier instruction schema explicitly isolating system guidelines, instruction queries, context inputs, and target responses.</p>
                <div className="bg-slate-900 p-2 rounded text-[11px] font-mono text-slate-300 overflow-x-auto">
                  &#123; system: "...", instruction: "...", input: "...", response: "..." &#125;
                </div>
              </div>

              <div className="bg-slate-950/70 p-3.5 rounded-xl border border-slate-800">
                <div className="font-bold text-purple-400 mb-1">4. DeepSeek R1 / Reasoning (&lt;think&gt;)</div>
                <p className="text-slate-400 mb-2">Embeds step-by-step thinking traces inside <code>&lt;think&gt;...&lt;/think&gt;</code> tags directly preceding the response content in assistant turns.</p>
                <div className="bg-slate-900 p-2 rounded text-[11px] font-mono text-slate-300 overflow-x-auto">
                  content: "&lt;think&gt;\nStep 1 reasoning...\n&lt;/think&gt;\n\nFinal answer."
                </div>
              </div>

              <div className="bg-slate-950/70 p-3.5 rounded-xl border border-slate-800 md:col-span-2">
                <div className="font-bold text-cyan-400 mb-1">5. OpenAI o1/o3, ShareGPT &amp; Completion Pairs</div>
                <p className="text-slate-400 mb-2">Full interoperability with o1/o3 reasoning keys (<code>reasoning_content</code>), ShareGPT multi-turn dialogues (<code>conversations: [from, value]</code>), and completion pairs (<code>prompt, response</code>).</p>
                <div className="bg-slate-900 p-2 rounded text-[11px] font-mono text-slate-300 overflow-x-auto">
                  &#123; reasoning_content: "...", content: "..." &#125; | &#123; conversations: [...] &#125; | &#123; prompt: "...", response: "..." &#125;
                </div>
              </div>
            </div>
          </section>

          {/* TRiAD Alignment */}
          <section className="bg-slate-950/80 p-4 rounded-xl border border-slate-800 space-y-2">
            <h3 className="text-white font-semibold text-sm flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" /> TRiAD Core Alignment Standard
            </h3>
            <p className="text-xs text-slate-300">
              When fine-tuning models, avoid relies solely on heavy post-hoc RLHF/guardrail filters. TRiAD AI dataset curation injects <strong>Freedom, Truth, and Kindness</strong> natively into training prompt-completion pairs to produce balanced, authentic, and reliable assistant personas.
            </p>
          </section>

          {/* Agency & Enterprise link */}
          <div className="p-4 rounded-xl bg-gradient-to-r from-emerald-950/30 to-blue-950/30 border border-slate-800 flex items-center justify-between">
            <div>
              <div className="text-white font-semibold text-sm">Need Custom Engineering or Agency Datasets?</div>
              <div className="text-xs text-slate-400">TRiADiC Intelligence Labs provides custom dataset curation and fine-tuning pipelines.</div>
            </div>
            <a
              href="https://triadai.agency"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3.5 py-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs rounded-xl flex items-center gap-1 transition shrink-0"
            >
              triadai.agency <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
