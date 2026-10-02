import React from "react";
import { CustomPackageModal } from "./CustomPackageModal";

interface PricingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenTeacherPortal?: () => void;
  onPurchasePro?: () => void;
}

export const PricingModal: React.FC<PricingModalProps> = ({ isOpen, onClose }) => {
  return (
    <CustomPackageModal
      isOpen={isOpen}
      onClose={onClose}
      currentGenerations={5000}
      limit={5000}
    />
  );
};


