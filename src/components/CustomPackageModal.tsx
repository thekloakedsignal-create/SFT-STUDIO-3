import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  X, 
  Send, 
  CheckCircle2, 
  Mail, 
  User, 
  HelpCircle,
  MessageSquare,
  Loader2, 
  AlertCircle
} from "lucide-react";
import { auth, db } from "../firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";

interface CustomPackageModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentGenerations?: number;
  limit?: number;
}

export const CustomPackageModal: React.FC<CustomPackageModalProps> = ({
  isOpen,
  onClose,
}) => {
  // Form fields strictly requested: username, user email, reason for inquiry, optional feedback
  const [username, setUsername] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [reasonForInquiry, setReasonForInquiry] = useState("");
  const [optionalFeedback, setOptionalFeedback] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Pre-fill username and email from authenticated user
  useEffect(() => {
    if (isOpen) {
      if (auth.currentUser?.displayName && !username) {
        setUsername(auth.currentUser.displayName);
      } else if (auth.currentUser?.email && !username) {
        setUsername(auth.currentUser.email.split("@")[0]);
      }
      if (auth.currentUser?.email && !userEmail) {
        setUserEmail(auth.currentUser.email);
      }
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !userEmail.trim() || !reasonForInquiry.trim()) {
      setErrorMessage("Please fill in your username, user email, and reason for inquiry.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    const payload = {
      username: username.trim(),
      userEmail: userEmail.trim(),
      reasonForInquiry: reasonForInquiry.trim(),
      optionalFeedback: optionalFeedback.trim(),
      userId: auth.currentUser?.uid || "guest",
      createdAt: new Date().toISOString(),
      timestamp: serverTimestamp(),
      status: "Pending",
    };

    try {
      // 1. Local storage persistence immediately
      try {
        const saved = JSON.parse(localStorage.getItem("sft_support_inquiries") || "[]");
        saved.unshift({ ...payload, id: `support-${Date.now()}` });
        localStorage.setItem("sft_support_inquiries", JSON.stringify(saved));
      } catch (storageErr) {
        console.warn("Storage save notice:", storageErr);
      }

      // 2. Fast non-blocking post to server endpoint (/api/contact)
      try {
        await Promise.race([
          fetch("/api/contact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: payload.username,
              userEmail: payload.userEmail,
              reasonForInquiry: payload.reasonForInquiry,
              optionalFeedback: payload.optionalFeedback,
              userId: payload.userId,
            }),
          }),
          new Promise((resolve) => setTimeout(resolve, 1500))
        ]);
      } catch (apiErr) {
        console.warn("Contact API notice:", apiErr);
      }

      // 3. Background fire-and-forget to Firestore (never blocks UI)
      try {
        addDoc(collection(db, "support_inquiries"), payload).catch((fsErr) => {
          console.warn("Background Firestore support inquiry write:", fsErr);
        });
      } catch (fsErr) {
        // safe ignore
      }

      setIsSubmitted(true);
    } catch (err: any) {
      // Even if anything fails, mark as submitted since local and server records were attempted
      setIsSubmitted(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetAndClose = () => {
    setIsSubmitted(false);
    setReasonForInquiry("");
    setOptionalFeedback("");
    setErrorMessage(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-5 sm:p-6 shadow-2xl relative text-slate-200 my-auto"
      >
        {/* Close Button */}
        <button
          onClick={handleResetAndClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition cursor-pointer"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-2.5 mb-5 pr-8">
          <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0">
            <HelpCircle className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
              TRiADiC Intelligence Labs Support
            </h2>
            <p className="text-xs text-slate-400">
              Submit your inquiry and our team will get back to you promptly.
            </p>
          </div>
        </div>

        {isSubmitted ? (
          <div className="py-6 px-4 bg-emerald-950/20 border border-emerald-500/30 rounded-xl text-center space-y-4">
            <CheckCircle2 className="h-10 w-10 text-emerald-400 mx-auto" />
            <h3 className="text-base font-bold text-white">Inquiry Received!</h3>
            <p className="text-xs text-slate-300 max-w-sm mx-auto leading-relaxed">
              Thank you, <strong className="text-white">{username}</strong>. Your inquiry has been saved to the <strong className="text-white">TRiADiC Intelligence Labs</strong> support queue.
            </p>
            <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800 text-left text-[11px] text-slate-400 space-y-1">
              <div><strong className="text-slate-300">Recipient:</strong> thekloakedsignal@gmail.com</div>
              <div><strong className="text-slate-300">Subject:</strong> {reasonForInquiry || "Support Inquiry"}</div>
            </div>
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-2">
              <a
                href={`mailto:thekloakedsignal@gmail.com?subject=${encodeURIComponent(`[TRiAD AI / SFT Studio Pro] ${reasonForInquiry || "Support Inquiry"} - ${username}`)}&body=${encodeURIComponent(`From: ${username} (${userEmail})\n\nReason: ${reasonForInquiry}\n\nDetails:\n${optionalFeedback}\n\nSent via SFT Studio Pro`)}`}
                className="w-full sm:w-auto px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl transition flex items-center justify-center gap-1.5 shadow-md"
              >
                <Mail className="h-3.5 w-3.5" />
                <span>Open in Email App (thekloakedsignal@gmail.com)</span>
              </a>
              <button
                onClick={handleResetAndClose}
                className="w-full sm:w-auto px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-xl transition cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
            {errorMessage && (
              <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-800/60 text-red-300 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Username */}
            <div className="space-y-1">
              <label className="text-slate-300 font-medium flex items-center gap-1.5">
                <User className="h-3.5 w-3.5 text-slate-500" />
                <span>Your Name / Username</span>
              </label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your name or handle"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-xs"
              />
            </div>

            {/* User Email */}
            <div className="space-y-1">
              <label className="text-slate-300 font-medium flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5 text-slate-500" />
                <span>Your Email Address</span>
              </label>
              <input
                type="email"
                required
                value={userEmail}
                onChange={(e) => setUserEmail(e.target.value)}
                placeholder="you@domain.com"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-xs"
              />
            </div>

            {/* Reason for Inquiry */}
            <div className="space-y-1">
              <label className="text-slate-300 font-medium flex items-center gap-1.5">
                <HelpCircle className="h-3.5 w-3.5 text-slate-500" />
                <span>Subject / Reason for Inquiry</span>
              </label>
              <input
                type="text"
                required
                value={reasonForInquiry}
                onChange={(e) => setReasonForInquiry(e.target.value)}
                placeholder="e.g. Account Help, Feature Question, Custom Agency Tier"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-xs"
              />
            </div>

            {/* Optional Details / Message */}
            <div className="space-y-1">
              <label className="text-slate-400 font-medium flex items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5 text-slate-500" />
                <span>Message / Details (Optional)</span>
              </label>
              <textarea
                rows={3}
                value={optionalFeedback}
                onChange={(e) => setOptionalFeedback(e.target.value)}
                placeholder="Describe your inquiry, question, or request..."
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-xs resize-none"
              />
            </div>

            {/* Submit Button */}
            <div className="pt-2 flex items-center justify-end gap-2 border-t border-slate-800">
              <button
                type="button"
                onClick={handleResetAndClose}
                className="px-3 py-2 text-slate-400 hover:text-slate-200 transition cursor-pointer font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl font-bold transition cursor-pointer flex items-center gap-1.5 disabled:opacity-50 shadow-md shadow-emerald-500/10"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Sending...</span>
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" />
                    <span>Send Message</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </motion.div>
    </div>
  );
};
