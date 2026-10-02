import React from "react";
import { motion } from "motion/react";
import { X, ExternalLink, Cpu, Sparkles, Building2, Layers, FileText, Bot, Database, Download, Lock, CheckCircle2 } from "lucide-react";

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full p-6 sm:p-8 shadow-2xl relative text-slate-200 my-8 max-h-[90vh] overflow-y-auto"
      >
        <button
          onClick={onClose}
          className="absolute top-6 right-6 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3.5 mb-6 border-b border-slate-800 pb-5">
          <img 
            src="/favicon.svg" 
            alt="TRiADiC Intelligence Labs Logo" 
            className="h-11 w-11 rounded-xl border border-emerald-500/30 shadow-lg shadow-emerald-500/10 shrink-0 object-cover" 
          />
          <div>
            <h2 className="text-2xl font-bold text-white tracking-tight">About SFT Studio Pro</h2>
            <p className="text-xs text-slate-400 mt-0.5">Production-Grade SFT Training Data Curator by TRiADiC Intelligence Labs</p>
          </div>
        </div>

        <div className="space-y-6 text-sm text-slate-300 leading-relaxed">
          {/* Main platform overview */}
          <section className="bg-slate-950/80 p-5 rounded-2xl border border-slate-800 space-y-3">
            <h3 className="text-white font-bold text-base flex items-center gap-2">
              <Cpu className="h-5 w-5 text-emerald-400" /> Complete Zero-to-Export Fine-Tuning Pipeline
            </h3>
            <p className="text-xs sm:text-sm text-slate-300">
              <strong>SFT Studio Pro</strong> is a production-grade, end-to-end supervised fine-tuning (SFT) training data curator. It gives machine learning engineers, researchers, and dataset creators full control over dataset synthesis, quality validation, format conversion, and export.
            </p>
          </section>

          {/* Key Platform Capabilities Grid */}
          <section className="space-y-3">
            <h3 className="text-white font-bold text-sm uppercase tracking-wider text-slate-400">Core Platform Features</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800/80 space-y-1.5">
                <div className="font-semibold text-emerald-400 flex items-center gap-2">
                  <Lock className="h-4 w-4" /> Locked Project Parameters
                </div>
                <p className="text-slate-400">
                  Enforces strict, consistent system prompts, target task specifications, negative constraints, and special instructions across all generated examples to guarantee model behavior alignment.
                </p>
              </div>

              <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800/80 space-y-1.5">
                <div className="font-semibold text-purple-400 flex items-center gap-2">
                  <Layers className="h-4 w-4" /> Sub-Batch Categories & Scale
                </div>
                <p className="text-slate-400">
                  Organize datasets into thematic sub-batch categories. Synthesize scalable generation batches (from test samples of 5 up to full production runs of 100) with unlockable scale tiers.
                </p>
              </div>

              <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800/80 space-y-1.5">
                <div className="font-semibold text-blue-400 flex items-center gap-2">
                  <FileText className="h-4 w-4" /> Document & Transcript Converter
                </div>
                <p className="text-slate-400">
                  Ingest raw knowledge documents, transcripts, and articles to extract structured, high-value multi-turn Q&amp;A and instruction-response dialogues automatically.
                </p>
              </div>

              <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800/80 space-y-1.5">
                <div className="font-semibold text-amber-400 flex items-center gap-2">
                  <Bot className="h-4 w-4" /> Context-Aware QA Assistant
                </div>
                <p className="text-slate-400">
                  Includes an embedded SFT data strategist companion for real-time dataset analysis, schema suggestions, prompt refinement, and interactive dataset feedback.
                </p>
              </div>

              <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800/80 space-y-1.5">
                <div className="font-semibold text-teal-400 flex items-center gap-2">
                  <Database className="h-4 w-4" /> Active Data Registry & Auditing
                </div>
                <p className="text-slate-400">
                  Review, edit, approve, or reject batch examples. Audit prompt diversity, duplicate detection, and completeness before approving data into active production registry.
                </p>
              </div>

              <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800/80 space-y-1.5">
                <div className="font-semibold text-emerald-400 flex items-center gap-2">
                  <Download className="h-4 w-4" /> Multi-Format Export Templates
                </div>
                <p className="text-slate-400">
                  Convert and export clean JSONL files tailored for <strong>ChatML</strong>, <strong>Alpaca</strong>, <strong>Mistral</strong>, <strong>DeepSeek R1</strong> (with <code>&lt;think&gt;</code> tags), <strong>OpenAI o1/o3</strong>, and <strong>ShareGPT</strong> formats.
                </p>
              </div>
            </div>
          </section>

          {/* TRiAD Philosophy Section */}
          <section className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
            <h3 className="text-emerald-400 font-semibold mb-2 flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4" /> TRiAD AI Native Alignment Model
            </h3>
            <p className="text-xs text-slate-300">
              Developed by <strong>TRiADiC Intelligence Labs</strong>, the TRiAD alignment model moves away from heavy post-training guardrails by instilling native model behavior into training datasets through three core principles:
            </p>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800">
                <span className="text-emerald-400 font-bold block mb-1">Freedom</span>
                <span className="text-slate-400 text-[11px]">User autonomy, non-coercive dialogue, and respect for choice.</span>
              </div>
              <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800">
                <span className="text-blue-400 font-bold block mb-1">Truth</span>
                <span className="text-slate-400 text-[11px]">Grounded accuracy, epistemological honesty, and clear limits.</span>
              </div>
              <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800">
                <span className="text-amber-400 font-bold block mb-1">Kindness</span>
                <span className="text-slate-400 text-[11px]">Constructive, patient, non-judgmental assistant guidance.</span>
              </div>
            </div>
          </section>

          {/* Agency CTA */}
          <section className="bg-emerald-950/20 border border-emerald-500/20 p-4 rounded-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h4 className="text-white font-semibold text-sm">TRiADiC Intelligence Labs Consulting</h4>
              <p className="text-xs text-slate-400 mt-0.5">
                Need bespoke dataset engineering, domain-specific fine-tuning, or private agency deployment?
              </p>
            </div>
            <a
              href="https://triadai.agency"
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-xs rounded-xl flex items-center gap-1.5 transition shrink-0 shadow-lg shadow-emerald-500/10 cursor-pointer"
            >
              Visit triadai.agency <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </section>
        </div>

        <div className="mt-6 pt-4 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-500">
          <span>© 2026 TRiADiC Intelligence Labs</span>
          <a href="https://triadai.agency" target="_blank" rel="noopener noreferrer" className="hover:text-emerald-400 transition flex items-center gap-1">
            triadai.agency <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </motion.div>
    </div>
  );
};
