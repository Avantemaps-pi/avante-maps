import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';

/**
 * Pi Network Authentication Verification
 * with Supabase Auth integration using native admin methods
 */

interface VerifyAuthRequest {
  accessToken: string;
  uid: string;
  username: string;
}

// Admin client (service role) for user management and DB writes
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }
);

// Public client (anon key) for verifying OTP and creating sessions
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_ANON_KEY')!,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }
);

// A new password for every sign-in: 32 random bytes as hex. Never derived from the uid or a key,
// never logged or returned. The session is all the client gets
const randomPassword = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 10; // 10 requests per minute

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  
  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return { allowed: true };
  }
  
  if (record.count >= MAX_REQUESTS) {
    return { allowed: false, retryAfter: Math.ceil((record.resetTime - now) / 1000) };
  }
  
  record.count++;
  return { allowed: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const traceId = crypto.randomUUID();
  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] || 
                   req.headers.get('x-real-ip') || 
                   'unknown';

  try {
    console.log(`🔍 [${traceId}] Request details:`, {
      method: req.method,
      clientIP,
      origin: req.headers.get('origin'),
      userAgent: req.headers.get('user-agent')?.substring(0, 100)
    });

    // 🛡️ Rate limiting check
    const rateLimitCheck = checkRateLimit(clientIP);
    if (!rateLimitCheck.allowed) {
      console.warn(`⚠️ [${traceId}] Rate limit exceeded for IP: ${clientIP}`);
      return new Response(JSON.stringify({
        verified: false,
        error: 'Too many requests',
        details: `Please wait ${rateLimitCheck.retryAfter} seconds before trying again.`,
        retryAfter: rateLimitCheck.retryAfter,
        traceId,
      }), { 
        status: 429, 
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json',
          'Retry-After': String(rateLimitCheck.retryAfter)
        } 
      });
    }

    console.log(`🚀 [${traceId}] verify-pi-auth invoked from IP: ${clientIP}`);

    // Test mode removed: Pi token verification is now always required.
    const testMode = false;

    const rawBody = await req.text();
    let parsedBody: VerifyAuthRequest;

    try {
      parsedBody = JSON.parse(rawBody);
      console.log(`📦 [${traceId}] Parsed request body:`, {
        hasAccessToken: !!parsedBody.accessToken,
        uid: parsedBody.uid,
        username: parsedBody.username
      });
    } catch (parseError) {
      console.error(`❌ [${traceId}] JSON parse error:`, {
        error: parseError instanceof Error ? parseError.message : 'Unknown error',
        rawBodyLength: rawBody.length,
        rawBodyPreview: rawBody.substring(0, 100)
      });
      return new Response(JSON.stringify({
        verified: false,
        error: 'Invalid request format',
        details: 'Body must be valid JSON.',
        traceId,
      }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { accessToken, uid, username } = parsedBody;

    // PRODUCTION: No dev token bypass allowed

    if (!accessToken || !uid || !username) {
      return new Response(JSON.stringify({
        verified: false,
        error: 'Missing required fields',
        details: 'accessToken, uid, and username are required.',
        traceId,
      }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Helper: Create session using signInWithPassword (most reliable for server-side).
    // Every sign-in sets a fresh random password first, so no password outlives the request.
    // Two sign-ins for the same user can race (the other one replaces the password between our
    // update and our sign-in): one retry with another new password
    const setPasswordAndSignIn = async (email: string, supabaseUserId: string) => {
      const password = randomPassword();
      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(supabaseUserId, { password });
      if (updateError) return { data: null, error: updateError };
      return await supabase.auth.signInWithPassword({ email, password });
    };

    const createUserSession = async (email: string, supabaseUserId: string) => {
      let { data, error } = await setPasswordAndSignIn(email, supabaseUserId);

      if (!error && data?.session) return { data, error };

      const msg = (error?.message || '').toLowerCase();
      const status = (error as { status?: number } | null)?.status;
      const invalidCreds = msg.includes('invalid login') || msg.includes('invalid') || status === 400;

      if (invalidCreds) {
        console.warn(`🔧 [${traceId}] signInWithPassword failed (invalid creds, likely a concurrent sign-in). Retrying once with a new password...`);
        ({ data, error } = await setPasswordAndSignIn(email, supabaseUserId));
      }

      return { data, error };
    };

    // ✅ Test mode (development / preview)
    if (testMode) {
      console.log(`🧪 [${traceId}] Test mode: ensure user exists and create session`);

      // Use UID-based email to avoid UNIQUE constraint violations when username changes
      const email = `${uid}@pi.local`;

      // Ensure user exists (idempotent)
      const { data: usersList, error: listError } = await supabaseAdmin.auth.admin.listUsers();
      if (listError) {
        console.error(`❌ [${traceId}] Failed to list users:`, listError);
        throw new Error(`Failed to list users: ${listError.message}`);
      }
      
      // Find user by pi_uid in metadata OR by email (for legacy users created before pi_uid was added)
      const existingUser = usersList?.users.find((u) => 
        u.user_metadata?.pi_uid === uid || u.email === email
      );
      
      let supabaseUserId: string;

      if (!existingUser) {
        console.log(`🔨 [${traceId}] Creating new test user:`, { pi_uid: uid, email, username });
        const { data: newUserData, error: createError } = await supabaseAdmin.auth.admin.createUser({
          email,
          password: randomPassword(),
          email_confirm: true,
          user_metadata: { username, full_name: username, pi_uid: uid },
        });
        if (createError) {
          console.error(`❌ [${traceId}] Failed to create user:`, createError);
          throw new Error(`Failed to create user: ${createError.message}`);
        }
        
        supabaseUserId = newUserData.user.id;
        console.log(`✅ [${traceId}] Created test Supabase user ${supabaseUserId} for Pi UID ${uid}`);
        
        // Insert into public.users
        const { error: insertError } = await supabaseAdmin
          .from('users')
          .insert({
            id: supabaseUserId,
            pi_uid: uid,
            username,
            email,
            subscription: 'individual',
          });
        
        if (insertError) {
          console.error(`❌ [${traceId}] Failed to create public user:`, insertError);
          throw new Error(`Failed to create public user: ${insertError.message}`);
        }
      } else {
        supabaseUserId = existingUser.id;
        console.log(`ℹ️ [${traceId}] Test user already exists:`, { supabaseUserId, pi_uid: uid });
        
        // Check if we need to update email or pi_uid metadata
        const needsEmailUpdate = existingUser.email !== email;
        const needsPiUidUpdate = existingUser.user_metadata?.pi_uid !== uid;
        
        if (needsEmailUpdate || needsPiUidUpdate) {
          console.log(`🔄 [${traceId}] Updating user:`, { 
            emailChange: needsEmailUpdate ? `${existingUser.email} -> ${email}` : 'no',
            piUidChange: needsPiUidUpdate ? `${existingUser.user_metadata?.pi_uid} -> ${uid}` : 'no'
          });
          const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(supabaseUserId, {
            email,
            email_confirm: true,
            user_metadata: { ...existingUser.user_metadata, pi_uid: uid, username },
          });
          if (updateError) {
            console.error(`❌ [${traceId}] Failed to update user:`, updateError);
            throw new Error(`Failed to update user: ${updateError.message}`);
          }
          
          // Also update public.users table
          await supabaseAdmin.from('users').update({ email, pi_uid: uid }).eq('id', supabaseUserId);
        }
      }

      console.log(`🔐 [${traceId}] [TEST] Creating session for user ${supabaseUserId}`);

      const { data: sessionData, error: sessionError } = await createUserSession(email, supabaseUserId);

      if (sessionError || !sessionData?.session) {
        console.error(`❌ [${traceId}] [TEST] Failed to create session:`, sessionError);
        return new Response(JSON.stringify({
          verified: false,
          error: 'Session creation failed',
          details: sessionError?.message || 'Could not create authentication session',
          traceId,
        }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const { access_token, refresh_token } = sessionData.session;

      console.log(`✅ [${traceId}] [TEST] Session created`, {
        hasAccessToken: !!access_token,
        accessTokenLen: access_token?.length ?? 0,
        hasRefreshToken: !!refresh_token,
        refreshTokenLen: refresh_token?.length ?? 0,
      });

      if (!refresh_token) {
        return new Response(
          JSON.stringify({
            verified: false,
            error: 'Session creation failed',
            details: 'No refresh token returned from Supabase',
            traceId,
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({
        verified: true,
        testMode: true,
        user: { uid: supabaseUserId, pi_uid: uid, username, wallet_address: 'TEST_WALLET_123' },
        supabase_token: access_token,
        refresh_token,
        // Backwards/forwards-compat aliases
        supabaseToken: access_token,
        refreshToken: refresh_token,
        traceId,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Verify token with Pi API ---
    console.log(`🔐 [${traceId}] Verifying token with Pi API`);
    const verifyResponse = await fetch('https://api.minepi.com/v2/me', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const rawResponse = await verifyResponse.text();
    console.log(`📡 [${traceId}] Pi API response:`, {
      status: verifyResponse.ok,
      statusCode: verifyResponse.status,
      responseLength: rawResponse.length
    });

    if (!verifyResponse.ok) {
      console.error(`❌ [${traceId}] Pi API verification failed:`, {
        status: verifyResponse.status,
        response: rawResponse.substring(0, 200)
      });
      return new Response(JSON.stringify({
        verified: false,
        error: 'Authentication failed',
        details: 'Could not verify credentials with Pi Network',
        traceId,
      }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const piUserData = JSON.parse(rawResponse);
    const user = piUserData.user ?? piUserData;
    
    console.log(`👤 [${traceId}] Pi user data:`, {
      uid: user.uid,
      username: user.username,
      hasWallet: !!user.wallet_address
    });

    if (user.uid !== uid || user.username !== username) {
      console.error(`❌ [${traceId}] User mismatch:`, {
        expectedUid: uid,
        actualUid: user.uid,
        expectedUsername: username,
        actualUsername: user.username
      });
      return new Response(JSON.stringify({
        verified: false,
        error: 'Authentication failed',
        details: 'Credential verification failed',
        traceId,
      }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // --- Supabase Auth Integration ---
    console.log(`🔧 [${traceId}] Setting up Supabase auth integration`);
    // Use UID-based email to avoid UNIQUE constraint violations when username changes
    const email = `${uid}@pi.local`;

    const { data: usersList, error: listError } = await supabaseAdmin.auth.admin.listUsers();
    if (listError) {
      console.error(`❌ [${traceId}] Failed to list users:`, listError);
      throw new Error(`Failed to list users: ${listError.message}`);
    }
    
    // Find user by pi_uid in metadata OR by email (for legacy users created before pi_uid was added)
    const existingUser = usersList?.users.find((u) => 
      u.user_metadata?.pi_uid === uid || u.email === email
    );

    let supabaseUserId: string;
    
    if (!existingUser) {
      console.log(`🔨 [${traceId}] Creating new Supabase user:`, { pi_uid: uid, email, username });
      const { data: newUserData, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: randomPassword(),
        email_confirm: true,
        user_metadata: { username, full_name: username, pi_uid: uid },
      });
      
      if (createError) {
        console.error(`❌ [${traceId}] Failed to create user:`, createError);
        throw new Error(`Failed to create user: ${createError.message}`);
      }
      
      supabaseUserId = newUserData.user.id;
      console.log(`✅ [${traceId}] Created Supabase user ${supabaseUserId} for Pi UID ${uid}`);
      
      // Insert into public.users
      const { error: insertError } = await supabaseAdmin
        .from('users')
        .insert({
          id: supabaseUserId,
          pi_uid: uid,
          username,
          email,
          subscription: 'individual',
        });
      
      if (insertError) {
        console.error(`❌ [${traceId}] Failed to create public user:`, insertError);
        throw new Error(`Failed to create public user: ${insertError.message}`);
      }
    } else {
      supabaseUserId = existingUser.id;
      console.log(`ℹ️ [${traceId}] User already exists:`, { supabaseUserId, pi_uid: uid });
      
      // Check if we need to update email or pi_uid metadata
      const needsEmailUpdate = existingUser.email !== email;
      const needsPiUidUpdate = existingUser.user_metadata?.pi_uid !== uid;
      
      if (needsEmailUpdate || needsPiUidUpdate) {
        console.log(`🔄 [${traceId}] Updating user:`, { 
          emailChange: needsEmailUpdate ? `${existingUser.email} -> ${email}` : 'no',
          piUidChange: needsPiUidUpdate ? `${existingUser.user_metadata?.pi_uid} -> ${uid}` : 'no'
        });
        const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(supabaseUserId, {
          email,
          email_confirm: true,
          user_metadata: { ...existingUser.user_metadata, pi_uid: uid, username },
        });
        if (updateError) {
          console.error(`❌ [${traceId}] Failed to update user:`, updateError);
          throw new Error(`Failed to update user: ${updateError.message}`);
        }
        
        // Also update public.users table
        await supabaseAdmin.from('users').update({ email, pi_uid: uid }).eq('id', supabaseUserId);
      }
    }

    console.log(`🔐 [${traceId}] Creating session for user ${supabaseUserId}`);
    
    const { data: sessionData, error: sessionError } = await createUserSession(email, supabaseUserId);

    if (sessionError || !sessionData?.session) {
      console.error(`❌ [${traceId}] Failed to create session:`, sessionError);
      return new Response(JSON.stringify({
        verified: false,
        error: 'Session creation failed',
        details: sessionError?.message || 'Could not create authentication session',
        traceId,
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { access_token, refresh_token } = sessionData.session;

    console.log(`✅ [${traceId}] Session created`, {
      hasAccessToken: !!access_token,
      accessTokenLen: access_token?.length ?? 0,
      hasRefreshToken: !!refresh_token,
      refreshTokenLen: refresh_token?.length ?? 0,
    });

    if (!refresh_token) {
      return new Response(JSON.stringify({
        verified: false,
        error: 'Session creation failed',
        details: 'No refresh token returned from Supabase',
        traceId,
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      verified: true,
      user: {
        uid: supabaseUserId,
        pi_uid: uid,
        username: user.username,
        wallet_address: user.wallet_address || null,
      },
      supabase_token: access_token,
      refresh_token,
      // Backwards/forwards-compat aliases
      supabaseToken: access_token,
      refreshToken: refresh_token,
      traceId,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error(`💥 [${traceId}] Internal error:`, {
      error: err instanceof Error ? err.message : 'Unknown error',
      stack: err instanceof Error ? err.stack : undefined,
      type: err?.constructor?.name
    });
    return new Response(JSON.stringify({
      verified: false,
      error: 'Authentication service error',
      details: 'An unexpected error occurred during authentication',
      traceId,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
