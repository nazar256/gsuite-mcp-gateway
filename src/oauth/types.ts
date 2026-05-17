export interface AuthorizationStatePayload {
  v: 1;
  kind: 'google_oauth_state';
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  resource: string;
  scope: string;
  grantNamespace?: string;
  createdAt: string;
}

export interface AuthorizationCodePayload {
  v: 1;
  kind: 'worker_authorization_code';
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  resource: string;
  scope: string;
  grantId: string;
  subject: string;
  createdAt: string;
}

export interface WorkerAccessTokenClaims {
  typ: 'access_token';
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string;
  resource: string;
  grant_id: string;
  iat: number;
  exp: number;
}

export interface WorkerRefreshTokenClaims {
  typ: 'refresh_token';
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  grant_id: string;
  scope: string;
  resource: string;
  iat: number;
  exp: number;
}
