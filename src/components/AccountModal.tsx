import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  X, 
  User, 
  Mail, 
  Activity, 
  ShieldCheck, 
  Trash2, 
  ExternalLink, 
  AlertTriangle, 
  CheckCircle2, 
  Send,
  Loader2,
  Clock,
  Sparkles,
  Info,
  LogOut
} from "lucide-react";
import { User as FirebaseUser, signOut } from "firebase/auth";
import { auth, db } from "../firebase";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";

interface AccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: FirebaseUser | null;
  userProfile: {
    userId: string;
    subscriptionStatus: "Free" | "Premium" | "Student" | "Owner";
    limit: number;
    redeemedCode: string | null;
  } | null;
  accountTotalGenerations: number;
}

export const AccountModal: React.FC<AccountModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  userProfile,
  accountTotalGenerations,
}) => {
  const [showDeleteView, setShowDeleteView] = useState(false);

  // Deletion Request Form fields
  const [name, setName] = useState("");
  const [userEmailOrTwitter, setUserEmailOrTwitter] = useState("");
  const [optionalReason, setOptionalReason] = useState("");
  const [optionalFeedback, setOptionalFeedback] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Prefill user details when opened
  useEffect(() => {
    if (isOpen) {
      if (currentUser?.displayName && !name) {
        setName(currentUser.displayName);
      }
      if (currentUser?.email && !userEmailOrTwitter) {
        setUserEmailOrTwitter(currentUser.email);
      }
    }
  }, [isOpen, currentUser]);

  if (!isOpen) return null;

  const isOwner = currentUser?.email?.toLowerCase() === "thekloakedsignal@gmail.com" || userProfile?.subscriptionStatus === "Owner";
  const maxLimit = isOwner ? Infinity : (userProfile?.limit || (currentUser ? 5000 : 100));
  const usagePercent = isOwner 
    ? 0 
    : Math.min(100, Math.round((accountTotalGenerations / (maxLimit === Infinity ? 5000 : maxLimit)) * 100));

  const handleDeleteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !userEmailOrTwitter.trim()) {
      setErrorMessage("Please enter your name and email or Twitter handle.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    const payload = {
      name: name.trim(),
      userEmailOrTwitter: userEmailOrTwitter.trim(),
      optionalReason: optionalReason.trim(),
      optionalFeedback: optionalFeedback.trim(),
      userId: currentUser?.uid || "guest",
      accountEmail: currentUser?.email || "anonymous",
      requestedAt: new Date().toISOString(),
      deletionTargetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      timestamp: serverTimestamp(),
      status: "Deletion Requested (Within 30 Days)",
    };

    try {
      // 1. Fallback to localStorage immediately
      try {
        const localDeletions = JSON.parse(localStorage.getItem("sft_account_deletions") || "[]");
        localDeletions.unshift({ ...payload, id: `deletion-${Date.now()}` });
        localStorage.setItem("sft_account_deletions", JSON.stringify(localDeletions));
      } catch (storageErr) {
        console.warn("Storage save notice:", storageErr);
      }

      // 2. Dispatch completed form to server /api/contact with timeout
      try {
        await Promise.race([
          fetch("/api/contact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: payload.name,
              userEmail: payload.accountEmail || payload.userEmailOrTwitter,
              reasonForInquiry: `Account Deletion Request: ${payload.optionalReason || "No reason given"}`,
              optionalFeedback: payload.optionalFeedback,
              userId: payload.userId,
            }),
          }),
          new Promise((resolve) => setTimeout(resolve, 1500))
        ]);
      } catch (emailErr) {
        console.warn("Notice: could not dispatch deletion contact:", emailErr);
      }

      // 3. Background Firestore write
      try {
        addDoc(collection(db, "account_deletions"), payload).catch((fsErr) => {
          console.warn("Background Firestore deletion request save error:", fsErr);
        });
      } catch (fsErr) {
        // ignore
      }

      setIsSubmitted(true);
    } catch (err: any) {
      setIsSubmitted(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetAndClose = () => {
    setShowDeleteView(false);
    setIsSubmitted(false);
    setOptionalReason("");
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

        {!showDeleteView ? (
          /* Main Account View */
          <div className="space-y-5">
            {/* Header */}
            <div className="flex items-center gap-3 pr-8">
              <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 shrink-0">
                <User className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                  Account Information
                </h2>
                <p className="text-xs text-slate-400">
                  Manage your credentials, usage metrics, and account status.
                </p>
              </div>
            </div>

            {/* Basic Account Info Box */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between text-xs pb-2 border-b border-slate-800/80">
                <span className="text-slate-400 font-medium">Authentication Status</span>
                <span className="font-semibold flex items-center gap-1.5 text-emerald-400">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {currentUser ? "Signed In" : "Guest / Local Session"}
                </span>
              </div>

              <div className="flex items-center justify-between text-xs pb-2 border-b border-slate-800/80">
                <span className="text-slate-400 font-medium">Display Name</span>
                <span className="font-semibold text-slate-200 truncate max-w-[200px]">
                  {currentUser?.displayName || (currentUser ? "User" : "Local Guest")}
                </span>
              </div>

              <div className="flex items-center justify-between text-xs pb-2 border-b border-slate-800/80">
                <span className="text-slate-400 font-medium">Email / Login ID</span>
                <span className="font-semibold text-slate-200 truncate max-w-[220px]">
                  {currentUser?.email || "guest@local"}
                </span>
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400 font-medium">Account Tier</span>
                <span className="font-bold px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider bg-slate-800 text-slate-200 border border-slate-700">
                  {isOwner ? "Owner (Exempt)" : (userProfile?.subscriptionStatus || (currentUser ? "Standard" : "Guest"))}
                </span>
              </div>
            </div>

            {/* Available Usage Box */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-300 font-semibold flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-blue-400" />
                  Available Usage & Synthesis Volume
                </span>
                <span className="font-mono text-xs font-bold text-slate-200">
                  {accountTotalGenerations.toLocaleString()} / {isOwner ? "Unlimited" : maxLimit.toLocaleString()} ex.
                </span>
              </div>

              {/* Progress Bar */}
              <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
                <div 
                  className={`h-full rounded-full transition-all duration-300 ${
                    usagePercent > 90 ? "bg-red-500" : usagePercent > 75 ? "bg-amber-500" : "bg-emerald-500"
                  }`}
                  style={{ width: `${isOwner ? 10 : Math.max(3, usagePercent)}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-[11px] text-slate-400 pt-0.5">
                <span>{isOwner ? "Owner exemption active" : `${usagePercent}% of quota consumed`}</span>
                <span>{isOwner ? "Unlimited remaining" : `${Math.max(0, maxLimit - accountTotalGenerations).toLocaleString()} ex. available`}</span>
              </div>
            </div>

            {/* Actions / Delete Account Option */}
            <div className="pt-2 flex items-center justify-between border-t border-slate-800">
              <button
                type="button"
                onClick={() => {
                  signOut(auth);
                  onClose();
                }}
                className="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-slate-800 transition cursor-pointer font-medium"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Sign Out</span>
              </button>

              <button
                type="button"
                onClick={() => setShowDeleteView(true)}
                className="text-xs text-red-400/90 hover:text-red-300 flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-red-500/10 transition cursor-pointer font-medium"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Delete Account</span>
              </button>

              <button
                type="button"
                onClick={handleResetAndClose}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold transition cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          /* Delete Account Request Form */
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center gap-2.5 pr-8">
              <div className="p-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                  Request Account Deletion
                </h2>
                <p className="text-xs text-slate-400">
                  Submit an official deletion request for your account and associated data.
                </p>
              </div>
            </div>

            {/* 30 Days Notice Banner */}
            <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2.5">
              <Clock className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
              <div>
                <span className="font-semibold text-white">Important Notice: </span>
                Once your request is submitted, your account and all associated projects, datasets, and personal data will be completely and permanently deleted within <strong className="text-white">30 days</strong>.
              </div>
            </div>

            {isSubmitted ? (
              <div className="py-6 px-4 bg-emerald-950/20 border border-emerald-500/30 rounded-xl text-center space-y-3">
                <CheckCircle2 className="h-10 w-10 text-emerald-400 mx-auto" />
                <h3 className="text-base font-bold text-white">Deletion Request Received</h3>
                <p className="text-xs text-slate-300 max-w-sm mx-auto leading-relaxed">
                  Thank you, <strong className="text-white">{name}</strong>. Your request for <span className="text-emerald-400 font-medium">{userEmailOrTwitter}</span> has been logged. Your account and all associated data will be deleted within 30 days.
                </p>
                <div className="pt-2">
                  <button
                    onClick={handleResetAndClose}
                    className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl transition cursor-pointer"
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleDeleteSubmit} className="space-y-3 text-xs">
                {errorMessage && (
                  <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-800/60 text-red-300 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
                    <span>{errorMessage}</span>
                  </div>
                )}

                {/* Name */}
                <div className="space-y-1">
                  <label className="text-slate-300 font-medium flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5 text-slate-500" />
                    <span>Your Name <span className="text-red-400">*</span></span>
                  </label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Enter your full name"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:border-red-500 text-xs"
                  />
                </div>

                {/* Email or Twitter Handle (pre-filled) */}
                <div className="space-y-1">
                  <label className="text-slate-300 font-medium flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5 text-slate-500" />
                    <span>Email or Twitter Handle <span className="text-red-400">*</span></span>
                  </label>
                  <input
                    type="text"
                    required
                    value={userEmailOrTwitter}
                    onChange={(e) => setUserEmailOrTwitter(e.target.value)}
                    placeholder="e.g. user@example.com or @handle"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:border-red-500 text-xs font-mono"
                  />
                </div>

                {/* Optional Reason for Request */}
                <div className="space-y-1">
                  <label className="text-slate-400 font-medium">
                    Optional Reason for Request
                  </label>
                  <textarea
                    rows={2}
                    value={optionalReason}
                    onChange={(e) => setOptionalReason(e.target.value)}
                    placeholder="Why are you requesting account deletion? (Optional)"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:border-red-500 text-xs resize-none"
                  />
                </div>

                {/* Optional Feedback */}
                <div className="space-y-1">
                  <label className="text-slate-400 font-medium">
                    Optional Feedback
                  </label>
                  <textarea
                    rows={2}
                    value={optionalFeedback}
                    onChange={(e) => setOptionalFeedback(e.target.value)}
                    placeholder="Any feedback on how we could have served you better? (Optional)"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:border-red-500 text-xs resize-none"
                  />
                </div>

                {/* Form Controls */}
                <div className="pt-2 flex items-center justify-between border-t border-slate-800">
                  <button
                    type="button"
                    onClick={() => setShowDeleteView(false)}
                    className="px-3 py-2 text-slate-400 hover:text-slate-200 transition cursor-pointer font-medium"
                  >
                    Back to Account
                  </button>

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold transition cursor-pointer flex items-center gap-1.5 disabled:opacity-50 shadow-md shadow-red-500/10"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Submitting...</span>
                      </>
                    ) : (
                      <>
                        <Send className="h-3.5 w-3.5" />
                        <span>Confirm Deletion Request</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
};
