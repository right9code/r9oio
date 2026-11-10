// Minimal local stand-in for the upstream OAuth service types file.
// Shapes are reconstructed from how consumers read these values.

export type SubscriptionType = 'free' | 'pro' | 'max' | 'team' | 'enterprise'

export type BillingType = 'contract' | 'self_serve'

export type RateLimitTier =
  | 'default'
  | 'default_claude_max_5x'
  | 'default_claude_max_20x'
  | string

export type OAuthTokens = {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: number | null
  scopes: string[]
  subscriptionType?: SubscriptionType | null
  rateLimitTier?: RateLimitTier | null
  profile?: OAuthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string | null
  }
}

export type OAuthTokenExchangeResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type?: string
  account?: {
    uuid: string
    email_address: string
  }
  organization?: {
    uuid: string
  }
}

export type OAuthProfileResponse = {
  account: {
    uuid: string
    email_address: string
    display_name?: string
    created_at?: string
  }
  organization: {
    uuid: string
    organization_type?: string
    rate_limit_tier?: RateLimitTier | null
    has_extra_usage_enabled?: boolean | null
    billing_type?: BillingType | null
    subscription_created_at?: string
  }
}

export type UserRolesResponse = {
  organization_role?: string | null
  workspace_role?: string | null
  organization_name?: string | null
}

export type ReferrerRewardInfo = {
  amount_minor_units: number
  currency: string
}

export type ReferralEligibilityResponse = {
  eligible: boolean
  campaign?: string
  referral_code_details?: {
    referral_link?: string
    campaign?: string
  } | null
  referrer_reward?: ReferrerRewardInfo | null
  remaining_passes?: number | null
}

export type ReferralRedemptionsResponse = {
  redemptions?: Array<{
    redeemed_at?: string
    [key: string]: unknown
  }>
  limit?: number
}
