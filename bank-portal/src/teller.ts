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

/** Emitted when Connect closes after an in-flow error (see Teller Connect docs). */
export type TellerConnectFailure = {
  type?: string;
  code?: string;
  message?: string;
};

export interface TellerConnectSetupOptions {
  applicationId: string;
  environment?: string;
  products: string[];
  enrollmentId?: string;
  nonce?: string;
  onSuccess: (payload: TellerEnrollmentPayload) => void;
  onExit?: () => void;
  onInit?: () => void;
  onFailure?: (failure: TellerConnectFailure) => void;
}

declare global {
  interface Window {
    TellerConnect?: {
      setup: (options: TellerConnectSetupOptions) => TellerConnectInstance;
    };
  }
}

export {};
