export type RootStackParamList = {
  Onboarding:       undefined;
  Tutorial:         undefined;
  ForgotPassword:   undefined;
  VerifyEmail:      { email: string; uid: string; idToken: string; refreshToken: string; expiresIn: string };
  MainTabs:         undefined;
  CharacterList:    undefined;
  CharacterConfig:  { character: string };
  CharacterVariants:      { character: string };
  HandwritingCustomizer:  undefined;
  CharacterCapture: { character: string; totalSamples: number; existingSamples?: string[]; returnTo?: 'CharacterVariants' };
  CharacterSampleReview: { character: string; samples: string[]; totalSamples: number; returnTo?: 'CharacterVariants' };
  Camera:           { missingChars?: string[] } | undefined;
  Review:           { bank?: Record<string, unknown>; photoUri?: string };
  Editor:           undefined;
  Preview:          {
    text:       string;
    background: string;
    inkColor:   'black' | 'blue' | 'red';
    style:      { charHeight: number; letterSpacing: number; wordSpacing: number; baselineJitter: number; slant: number; inkBlobs: number };
    // Each character maps to ALL its variant URLs so the renderer can pick a
    // different sample per occurrence.
    glyphMap:   Record<string, string[]>;
  };
  FinalView:        {
    text:        string;
    background:  string;
    glyphMap:    Record<string, string[]>;  // kept for back-compat; FinalView doesn't use it
    style:       { charHeight: number; letterSpacing: number; wordSpacing: number; baselineJitter: number; slant: number; inkBlobs: number };
    inkColor:    'black' | 'blue' | 'red';
  };
  Profile:          undefined;
  Settings:         undefined;
  Paywall:          undefined;
  PrivacyPolicy:    undefined;
  TermsOfService:   undefined;
  TermsAcceptance:  undefined;
  Contact:          undefined;
};
