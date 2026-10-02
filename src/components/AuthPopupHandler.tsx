import React, { useEffect, useState } from "react";
import { auth, googleProvider, signInWithPopup } from "../firebase";
import { GoogleAuthProvider } from "firebase/auth";
import { Sparkles, CheckCircle2, AlertCircle, RefreshCw, ExternalLink } from "lucide-react";

export const AuthPopupHandler: React.FC = () => {
  const [status, setStatus] = useState<"idle" | "authenticating" | "success" | "error">("authenticating");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [authenticatedUser, setAuthenticatedUser] = useState<any>(null);

  const startAuth = async () => {
    setStatus("authenticating");
    setErrorMessage(null);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      if (result?.user) {
        setAuthenticatedUser(result.user);
        setStatus("success");
        try {
          if (window.opener) {
            const credential = GoogleAuthProvider.credentialFromResult(result);
            const idToken = await result.user.getIdToken();
            window.opener.postMessage(
              { 
                type: "SFT_AUTH_SUCCESS", 
                uid: result.user.uid, 
                email: result.user.email,
                idToken: idToken,
                accessToken: credential?.accessToken
              }, 
              "*"
            );
          }
        } catch (e) {
          console.warn("Opener postMessage notice:", e);
        }
        // Auto close after brief display
        setTimeout(() => {
          try {
            window.close();
          } catch (e) {
            console.warn("Could not auto-close window:", e);
          }
        }, 800);
      }
    } catch (err: any) {
      console.error("Popup auth error:", err);
      setStatus("error");
      if (err?.code === "auth/popup-closed-by-user") {
        setErrorMessage("The authentication window was closed before completing. Click below to try again.");
      } else if (err?.code === "auth/unauthorized-domain") {
        setErrorMessage(`This domain (${window.location.hostname}) is not in Firebase authorized domains. Please add it to Firebase Console > Authentication > Settings.`);
      } else {
        setErrorMessage(err?.message || "Authentication failed. Please try again.");
      }
    }
  };

  useEffect(() => {
    startAuth();
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 select-none">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl text-center relative overflow-hidden">
        {/* Glow Header */}
        <div className="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-500/50 to-transparent" />

        {/* Logo */}
        <div className="flex justify-center mb-5">
          <img 
            src="/favicon.svg" 
            alt="TRiADiC" 
            className="h-14 w-14 rounded-2xl border border-emerald-500/30 shadow-lg shadow-emerald-500/20"
          />
        </div>

        <h1 className="text-xl font-bold text-white tracking-tight">
          SFT Studio Pro
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          Google Authentication Portal
        </p>

        {/* Status Views */}
        {status === "authenticating" && (
          <div className="my-8 py-4 space-y-3">
            <RefreshCw className="h-8 w-8 text-emerald-400 animate-spin mx-auto" />
            <div className="text-sm font-semibold text-slate-200">
              Connecting with Google...
            </div>
            <p className="text-xs text-slate-400 max-w-xs mx-auto">
              Please choose your Google account in the authentication prompt.
            </p>
          </div>
        )}

        {status === "success" && (
          <div className="my-8 py-4 space-y-3">
            <CheckCircle2 className="h-10 w-10 text-emerald-400 mx-auto animate-bounce" />
            <div className="text-sm font-bold text-white">
              Successfully Authenticated!
            </div>
            <p className="text-xs text-slate-300">
              Signed in as <strong className="text-emerald-400">{authenticatedUser?.email}</strong>
            </p>
            <p className="text-[11px] text-slate-500">
              Closing this window and returning to your workspace...
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="my-6 p-4 rounded-xl bg-red-950/40 border border-red-800/60 text-left space-y-2">
            <div className="flex items-center gap-2 text-red-400 text-xs font-bold">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>Authentication Notice</span>
            </div>
            <p className="text-xs text-red-300 leading-relaxed">
              {errorMessage}
            </p>
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-4 space-y-2">
          <button
            onClick={() => {
              try {
                window.close();
              } catch (e) {
                window.location.href = "/";
              }
            }}
            className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium text-xs transition cursor-pointer"
          >
            {status === "success" ? "Return to Workspace" : "Close This Window"}
          </button>
        </div>
      </div>
    </div>
  );
};
