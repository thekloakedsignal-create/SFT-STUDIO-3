import { Request, Response, NextFunction } from "express";
import { adminAuth } from "../lib/firebase-admin.ts";
import { DecodedIdToken } from "firebase-admin/auth";

export interface AuthRequest extends Request {
  user?: DecodedIdToken;
  deviceId?: string;
}

export const optionalAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  const headerDeviceId = req.headers["x-device-id"];
  if (typeof headerDeviceId === "string") {
    req.deviceId = headerDeviceId;
  }

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split("Bearer ")[1];
    try {
      const decodedToken = await adminAuth.verifyIdToken(token);
      req.user = decodedToken;
    } catch (error) {
      console.warn("Optional auth token verification notice:", error);
    }
  }
  next();
};
