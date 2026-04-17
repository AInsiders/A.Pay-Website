export interface TellerEnrollmentPayload {
  accessToken: string;
  user: { id: string };
  enrollment: {
    id: string;
    institution?: { name?: string };
  };
  signatures?: string[];
}

export interface TellerConnectInstance {
  open: () => void;
}

export interface TellerConnectSetupOptions {
  applicationId: string;
  environment?: string;
  products: string[];
  enrollmentId?: string;
  nonce?: string;
  onSuccess: (payload: TellerEnrollmentPayload) => void;
  onExit?: () => void;
  onInit?: () => void;
}

declare global {
  interface Window {
    TellerConnect?: {
      setup: (options: TellerConnectSetupOptions) => TellerConnectInstance;
    };
  }
}

export {};
