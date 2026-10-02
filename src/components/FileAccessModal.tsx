import React from "react";
import { ShieldCheck, Upload, Download, X, Lock, Check } from "lucide-react";

interface FileAccessModalProps {
  isOpen: boolean;
  type: "upload" | "export";
  onAccept: () => void;
  onDecline: () => void;
}

export const FileAccessModal: React.FC<FileAccessModalProps> = ({
  isOpen,
  type,
  onAccept,
  onDecline,
}) => {
  if (!isOpen) return null;

  const isUpload = type === "upload";

  return (
    <div 
      id="file-access-modal-backdrop"
      className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onDecline();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-access-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-lg w-full p-6 sm:p-7 shadow-2xl relative text-slate-200 my-8 transition-all"
      >
        {/* Header Close button */}
        <button
          type="button"
          id="btn-file-access-close"
          onClick={onDecline}
          className="absolute top-5 right-5 text-slate-400 hover:text-slate-100 p-1.5 rounded-lg hover:bg-slate-800/80 transition cursor-pointer"
          aria-label="Close dialog"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Logo & Security header */}
        <div className="flex items-center gap-3.5 mb-5 pb-4 border-b border-slate-800/80">
          <div className={`p-2.5 rounded-xl border shrink-0 ${
            isUpload 
              ? "bg-blue-500/10 border-blue-500/30 text-blue-400" 
              : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
          }`}>
            {isUpload ? <Upload className="h-6 w-6" /> : <Download className="h-6 w-6" />}
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Triad Intelligence Labs • Privacy &amp; Access
              </span>
            </div>
            <h2 id="file-access-modal-title" className="text-lg font-bold text-white tracking-tight mt-0.5">
              {isUpload ? "File Upload Access Request" : "File Export Access Request"}
            </h2>
          </div>
        </div>

        {/* Core Prompt Message - EXACT USER SPECIFIED PHRASING */}
        <div className="bg-slate-950/70 border border-slate-800/90 rounded-xl p-4.5 mb-5 space-y-3">
          <p className="text-sm text-slate-100 leading-relaxed font-medium">
            {isUpload
              ? "Triad intelligence labs is requesting access to your files for the purpose of uploading your document to the app. We do not store your documents."
              : "Triad intelligence labs is requesting access to your files for the purpose of exporting your file. We do not retain access to your personal information."}
          </p>

          <div className="flex items-center gap-2 text-[11px] text-slate-400 border-t border-slate-800/60 pt-3">
            <Lock className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
            <span>
              {isUpload 
                ? "In-browser processing only. Your documents are never stored or retained."
                : "Direct local export to your device. No personal data retained."}
            </span>
          </div>
        </div>

        {/* Options: Decline or Accept */}
        <div className="flex flex-col-reverse sm:flex-row items-center justify-end gap-3 pt-2">
          <button
            type="button"
            id="btn-file-access-decline"
            onClick={onDecline}
            className="w-full sm:w-auto px-5 py-2.5 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white text-xs font-semibold transition cursor-pointer flex items-center justify-center gap-1.5"
          >
            <span>Decline</span>
          </button>
          <button
            type="button"
            id="btn-file-access-accept"
            onClick={onAccept}
            className={`w-full sm:w-auto px-5 py-2.5 rounded-xl text-slate-950 text-xs font-bold transition cursor-pointer flex items-center justify-center gap-1.5 shadow-lg ${
              isUpload
                ? "bg-gradient-to-r from-blue-400 to-indigo-400 hover:from-blue-300 hover:to-indigo-300 shadow-blue-950/40"
                : "bg-gradient-to-r from-emerald-400 to-green-500 hover:from-emerald-300 hover:to-green-400 shadow-emerald-950/40"
            }`}
          >
            <Check className="h-4 w-4" />
            <span>Accept</span>
          </button>
        </div>
      </div>
    </div>
  );
};
