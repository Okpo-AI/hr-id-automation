"""
Lark OAuth 2.0 Authentication Service
Handles Lark SSO login with PKCE flow for secure authentication.

This service provides:
- OAuth 2.0 authorization code flow with PKCE
- Token exchange and refresh
- User info retrieval
- Session management integration

Security Features:
- PKCE (Proof Key for Code Exchange) with S256 method
- State parameter for CSRF protection
- Secure token handling
- Supabase-backed state storage for Vercel serverless compatibility

Lark API Endpoints:
- Authorization: https://accounts.larksuite.com/open-apis/authen/v1/authorize
- Token Exchange: https://open.larksuite.com/open-apis/authen/v2/oauth/token
- User Info: https://open.larksuite.com/open-apis/authen/v1/user_info
"""
import os
import secrets
import hashlib
import base64
import json
import logging
import time
from typing import Optional, Dict, Any, Tuple
from urllib.parse import urlencode, quote
import urllib.request
import urllib.error
from dotenv import load_dotenv
load_dotenv()
logger = logging.getLogger(__name__)

# ============================================
# Lark OAuth Configuration
# ============================================
LARK_APP_ID = os.getenv('LARK_APP_ID', 'cli_a866185f1638502f')
LARK_APP_SECRET = os.getenv('LARK_APP_SECRET', 'zaduPnvOLTxcb7W8XHYIaggtYgzOUOI6')

# Redirect URI - will be set based on environment
# Must be registered in Lark Developer Console -> Security Settings -> Redirect URLs
IS_VERCEL = os.getenv("VERCEL", "0") == "1" or os.getenv("VERCEL_ENV") is not None
# CRITICAL: Strip whitespace from env var to remove trailing newlines
# (copy/paste in Vercel dashboard can introduce \n causing OAuth error 20029)
_raw_redirect_uri = os.getenv('LARK_REDIRECT_URI')
_base_url = os.getenv('LARK_BASE_URL', '').strip()
if _raw_redirect_uri:
    DEFAULT_REDIRECT_URI = _raw_redirect_uri.strip()
elif _base_url:
    DEFAULT_REDIRECT_URI = f"{_base_url.rstrip('/')}/hr/lark/callback"
else:
    DEFAULT_REDIRECT_URI = 'http://localhost:8000/hr/lark/callback' if not IS_VERCEL else None

# Scopes to request (offline_access for refresh tokens)
LARK_SCOPES = os.getenv('LARK_SCOPES', '')

# Lark API Endpoints
AUTHORIZE_URL = "https://accounts.larksuite.com/open-apis/authen/v1/authorize"
TOKEN_URL = "https://open.larksuite.com/open-apis/authen/v2/oauth/token"
USER_INFO_URL = "https://open.larksuite.com/open-apis/authen/v1/user_info"
CONTACT_USER_URL = "https://open.larksuite.com/open-apis/contact/v3/users"
DEPARTMENT_URL = "https://open.larksuite.com/open-apis/contact/v3/departments"

# HR Portal Organization Access Control
# Only users in this department path can access HR Portal via Lark
# Hierarchy: S.P. Madrid & Associates > Solutions Management > People Development > People Support
# We validate by department ID (more reliable than names, survives renames)
TARGET_LARK_DEPARTMENT_ID = os.getenv('TARGET_LARK_DEPARTMENT_ID', '')
if not TARGET_LARK_DEPARTMENT_ID:
    logger.warning("TARGET_LARK_DEPARTMENT_ID environment variable not set. HR Portal org validation will fail.")

# Fallback department name checks (used if ID validation unavailable)
HR_ALLOWED_DEPARTMENTS = [
    "People Support",
    "People Development", 
    "Solutions Management",
    "S.P. Madrid & Associates"
]

# Cache for department hierarchy validation (reduces API calls)
# Format: {dept_id: {"is_people_support_descendant": bool, "expires": timestamp}}
_org_validation_cache: Dict[str, Dict[str, Any]] = {}
_ORG_CACHE_EXPIRY_SECONDS = 1800  # 30 minutes cache TTL

# In-memory storage for OAuth state (fallback for local development)
# In production with Vercel, we use Supabase for state persistence
_oauth_states: Dict[str, Dict[str, Any]] = {}
_STATE_EXPIRY_SECONDS = 600  # 10 minutes


def _cleanup_org_validation_cache():
    """Remove expired department validation cache entries"""
    current_time = time.time()
    expired_keys = [k for k, v in _org_validation_cache.items() 
                   if current_time > v.get('expires', 0)]
    for key in expired_keys:
        del _org_validation_cache[key]


# ============================================
# Supabase OAuth State Storage (Vercel Fix)
# ============================================
def _get_supabase_client():
    """Get Supabase client if available"""
    try:
        from app.database import supabase_client, USE_SUPABASE
        if USE_SUPABASE and supabase_client:
            return supabase_client
    except Exception as e:
        logger.debug(f"Supabase client not available: {e}")
    return None


def _store_oauth_state_supabase(state: str, code_verifier: str, redirect_uri: str) -> bool:
    """Store OAuth state in Supabase for serverless persistence"""
    client = _get_supabase_client()
    if not client:
        return False
    
    try:
        # Delete any existing state with same key (shouldn't happen but be safe)
        client.table("oauth_states").delete().eq("state", state).execute()
        
        # Insert new state
        client.table("oauth_states").insert({
            "state": state,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri
        }).execute()
        
        logger.info(f"OAuth state stored in Supabase: {state[:10]}...")
        return True
    except Exception as e:
        logger.warning(f"Failed to store OAuth state in Supabase: {e}")
        return False


def _retrieve_oauth_state_supabase(state: str) -> Optional[Dict[str, Any]]:
    """Retrieve OAuth state from Supabase"""
    client = _get_supabase_client()
    if not client:
        return None
    
    try:
        # First cleanup expired states
        try:
            client.rpc("cleanup_expired_oauth_states").execute()
        except:
            pass  # Function might not exist, that's ok
        
        # Retrieve state
        result = client.table("oauth_states").select("*").eq("state", state).execute()
        
        if result.data and len(result.data) > 0:
            state_data = result.data[0]
            
            # Delete state after retrieval (single-use)
            client.table("oauth_states").delete().eq("state", state).execute()
            
            logger.info(f"OAuth state retrieved from Supabase: {state[:10]}...")
            return {
                "code_verifier": state_data.get("code_verifier"),
                "redirect_uri": state_data.get("redirect_uri"),
                "created_at": time.time()  # Approximate for compatibility
            }
    except Exception as e:
        logger.warning(f"Failed to retrieve OAuth state from Supabase: {e}")
    
    return None


def _cleanup_expired_states():
    """Remove expired OAuth states from memory (local dev only)"""
    current_time = time.time()
    expired_keys = [
        key for key, value in _oauth_states.items()
        if current_time - value.get('created_at', 0) > _STATE_EXPIRY_SECONDS
    ]
    for key in expired_keys:
        del _oauth_states[key]


def _make_request(url: str, method: str = "GET", headers: Dict = None, data: Dict = None) -> Dict[str, Any]:
    """Make HTTP request to Lark API using urllib (no external dependencies)"""
    if headers is None:
        headers = {}
    
    headers["Content-Type"] = "application/json; charset=utf-8"
    
    request_data = None
    if data:
        request_data = json.dumps(data).encode('utf-8')
    
    req = urllib.request.Request(url, data=request_data, headers=headers, method=method)
    
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8') if e.fp else str(e)
        logger.error(f"Lark API HTTP error {e.code}: {error_body}")
        try:
            return json.loads(error_body)
        except:
            return {"code": e.code, "error": error_body}
    except Exception as e:
        logger.error(f"Lark API request error: {str(e)}")
        return {"code": -1, "error": str(e)}


# ============================================
# PKCE Helper Functions
# ============================================
def generate_pkce() -> Tuple[str, str]:
    """
    Generate PKCE code_verifier and code_challenge (S256 method).
    
    Returns:
        Tuple of (code_verifier, code_challenge)
    """
    # code_verifier: 43-128 characters of URL-safe random string
    code_verifier = secrets.token_urlsafe(64)[:128]
    
    # code_challenge: SHA256 hash of code_verifier, base64url encoded
    digest = hashlib.sha256(code_verifier.encode()).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    
    return code_verifier, code_challenge


# ============================================
# OAuth Flow Functions
# ============================================
def get_authorization_url(redirect_uri: str = None) -> Tuple[str, str]:
    """
    Generate Lark OAuth authorization URL with PKCE and state.
    
    VERCEL FIX: Uses Supabase to persist OAuth state across serverless invocations.
    In-memory storage only works in local development where the same process handles
    both the authorization request and callback.
    
    Args:
        redirect_uri: OAuth callback URL (uses default if not provided)
    
    Returns:
        Tuple of (authorization_url, state_token)
    """
    _cleanup_expired_states()
    
    if redirect_uri is None:
        redirect_uri = DEFAULT_REDIRECT_URI
    
    # Generate state for CSRF protection
    state = secrets.token_urlsafe(32)
    
    # Generate PKCE parameters
    code_verifier, code_challenge = generate_pkce()
    
    # VERCEL FIX: Store state in Supabase for persistence across serverless instances
    # Fall back to in-memory storage for local development
    state_stored_in_db = _store_oauth_state_supabase(state, code_verifier, redirect_uri)
    
    if not state_stored_in_db:
        # Fallback to in-memory (works for local development)
        _oauth_states[state] = {
            'code_verifier': code_verifier,
            'redirect_uri': redirect_uri,
            'created_at': time.time()
        }
        logger.info(f"OAuth state stored in memory (local dev): {state[:10]}...")
    
    # Build authorization URL
    params = {
        "client_id": LARK_APP_ID,
        "redirect_uri": redirect_uri,
        "scope": LARK_SCOPES,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    
    auth_url = f"{AUTHORIZE_URL}?{urlencode(params, quote_via=quote)}"
    logger.info(f"Generated Lark authorization URL with state: {state[:10]}..., redirect_uri: {redirect_uri}")
    
    return auth_url, state


def validate_state(state: str) -> Optional[Dict[str, Any]]:
    """
    Validate OAuth state and return stored data.
    
    VERCEL FIX: First tries to retrieve state from Supabase (for serverless),
    then falls back to in-memory storage (for local development).
    
    Args:
        state: State parameter from callback
    
    Returns:
        Stored OAuth state data or None if invalid/expired
    """
    if not state:
        logger.warning("OAuth state validation failed: state is empty")
        return None
    
    # VERCEL FIX: Try Supabase first (for serverless persistence)
    state_data = _retrieve_oauth_state_supabase(state)
    if state_data:
        return state_data
    
    # Fallback to in-memory storage (for local development)
    _cleanup_expired_states()
    
    if state not in _oauth_states:
        logger.warning(f"Invalid OAuth state (not in memory or DB): {state[:10]}...")
        return None
    
    state_data = _oauth_states.pop(state)  # Remove state after use (single-use)
    return state_data


def exchange_code_for_tokens(
    code: str,
    code_verifier: str,
    redirect_uri: str
) -> Dict[str, Any]:
    """
    Exchange authorization code for access and refresh tokens.
    
    Args:
        code: Authorization code from Lark callback
        code_verifier: PKCE code_verifier stored during authorization
        redirect_uri: Same redirect_uri used in authorization request
    
    Returns:
        Dict containing tokens or error information
    """
    token_data = {
        "grant_type": "authorization_code",
        "client_id": LARK_APP_ID,
        "client_secret": LARK_APP_SECRET,
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
    }
    
    logger.info("Exchanging authorization code for tokens...")
    response = _make_request(TOKEN_URL, method="POST", data=token_data)
    
    # Check for success (code 0 means success in Lark API)
    if str(response.get("code")) != "0":
        error_desc = response.get("error_description") or response.get("msg") or response.get("error") or "Unknown error"
        logger.error(f"Token exchange failed: {error_desc}")
        return {"success": False, "error": error_desc, "code": response.get("code")}
    
    logger.info("Token exchange successful")
    return {
        "success": True,
        "access_token": response.get("access_token"),
        "refresh_token": response.get("refresh_token"),
        "token_type": response.get("token_type"),
        "expires_in": response.get("expires_in"),
        "scope": response.get("scope")
    }


def get_user_info(access_token: str) -> Dict[str, Any]:
    """
    Get authenticated user's information from Lark.
    
    Args:
        access_token: User access token from token exchange
    
    Returns:
        Dict containing user info or error information
    """
    headers = {
        "Authorization": f"Bearer {access_token}"
    }
    
    logger.info("Fetching Lark user info...")
    response = _make_request(USER_INFO_URL, method="GET", headers=headers)
    
    if response.get("code") != 0:
        error_desc = response.get("msg") or "Failed to get user info"
        logger.error(f"User info fetch failed: {error_desc}")
        return {"success": False, "error": error_desc}
    
    user_data = response.get("data", {})
    logger.info(f"User info retrieved: {user_data.get('name', 'Unknown')}")
    
    return {
        "success": True,
        "user_id": user_data.get("user_id") or user_data.get("open_id"),
        "open_id": user_data.get("open_id"),
        "union_id": user_data.get("union_id"),
        "name": user_data.get("name"),
        "en_name": user_data.get("en_name"),
        "email": user_data.get("email"),
        "mobile": user_data.get("mobile"),  # Personal/mobile number from Lark
        "employee_no": user_data.get("employee_no"),  # Employee number from Lark (may be None from this API)
        "avatar_url": user_data.get("avatar_url"),
        "avatar_thumb": user_data.get("avatar_thumb"),
        "avatar_middle": user_data.get("avatar_middle"),
        "avatar_big": user_data.get("avatar_big"),
        "tenant_key": user_data.get("tenant_key"),
    }


def get_employee_no_from_contact_api(open_id: str) -> Optional[str]:
    """
    Get employee_no from Lark Contact API using tenant_access_token.
    The basic user_info API doesn't return employee_no, so we need to call Contact API.
    
    Args:
        open_id: User's open_id from authentication
    
    Returns:
        Employee number string or None if not available
    """
    # Import here to avoid circular imports
    from app.services.lark_service import get_tenant_access_token
    
    tenant_token = get_tenant_access_token()
    if not tenant_token:
        logger.warning("Could not get tenant_access_token for Contact API")
        return None
    
    # Call Contact API to get user details including employee_no
    url = f"{CONTACT_USER_URL}/{open_id}?user_id_type=open_id"
    headers = {
        "Authorization": f"Bearer {tenant_token}"
    }
    
    logger.info(f"Fetching employee_no from Contact API for open_id: {open_id[:10]}...")
    response = _make_request(url, method="GET", headers=headers)
    
    if response.get("code") != 0:
        error_msg = response.get("msg") or "Unknown error"
        logger.warning(f"Contact API failed: {error_msg} (code: {response.get('code')})")
        return None
    
    user_data = response.get("data", {}).get("user", {})
    employee_no = user_data.get("employee_no")
    
    if employee_no:
        logger.info(f"Employee number retrieved from Contact API: {employee_no}")
    else:
        logger.warning("Employee number not found in Contact API response")
    
    return employee_no


def get_user_department_info(open_id: str) -> Dict[str, Any]:
    """
    Get user's department information from Lark Contact API.
    Returns department IDs and names for validating organization access.
    
    Args:
        open_id: User's open_id from authentication
    
    Returns:
        Dict containing department_ids, department_names, and success status
    """
    from app.services.lark_service import get_tenant_access_token
    
    tenant_token = get_tenant_access_token()
    if not tenant_token:
        logger.warning("Could not get tenant_access_token for department info")
        return {"success": False, "error": "No tenant access token"}
    
    # Call Contact API to get user details including department_ids
    url = f"{CONTACT_USER_URL}/{open_id}?user_id_type=open_id&department_id_type=open_department_id"
    headers = {
        "Authorization": f"Bearer {tenant_token}"
    }
    
    logger.info(f"Fetching department info from Contact API for open_id: {open_id[:10]}...")
    response = _make_request(url, method="GET", headers=headers)
    
    if response.get("code") != 0:
        error_msg = response.get("msg") or "Unknown error"
        logger.warning(f"Contact API (department) failed: {error_msg} (code: {response.get('code')})")
        return {"success": False, "error": error_msg}
    
    user_data = response.get("data", {}).get("user", {})
    department_ids = user_data.get("department_ids", [])
    
    logger.info(f"User department IDs: {department_ids}")
    
    # Fetch department names for each department ID
    department_names = []
    for dept_id in department_ids:
        dept_name = get_department_name(dept_id, tenant_token)
        if dept_name:
            department_names.append(dept_name)
    
    logger.info(f"User department names: {department_names}")
    
    return {
        "success": True,
        "department_ids": department_ids,
        "department_names": department_names
    }


def get_department_name(department_id: str, tenant_token: str) -> Optional[str]:
    """
    Get department name from department ID.
    
    Args:
        department_id: The department's open_department_id
        tenant_token: Tenant access token
    
    Returns:
        Department name or None
    """
    url = f"{DEPARTMENT_URL}/{department_id}?department_id_type=open_department_id"
    headers = {
        "Authorization": f"Bearer {tenant_token}"
    }
    
    response = _make_request(url, method="GET", headers=headers)
    
    if response.get("code") != 0:
        logger.warning(f"Failed to get department name for {department_id}")
        return None
    
    dept_data = response.get("data", {}).get("department", {})
    return dept_data.get("name")


def is_descendant_of_people_support(open_id: str, tenant_token: str = None) -> Tuple[bool, str]:
    """
    Check if a user is a descendant of the People Support department.
    Uses department ID hierarchy validation for reliability.
    
    Implementation: 
    1. Get user's department IDs from Contact API
    2. For each department, check if it's the target or under it
    3. Cache results for 30 minutes to reduce API calls
    4. Re-validate on each request (not just login)
    
    Args:
        open_id: User's open_id from Lark
        tenant_token: Tenant access token (auto-fetched if None)
    
    Returns:
        Tuple of (is_authorized: bool, reason: str)
    """
    from app.services.lark_service import get_tenant_access_token
    
    if not TARGET_LARK_DEPARTMENT_ID:
        logger.warning("TARGET_LARK_DEPARTMENT_ID not configured. Cannot validate org access.")
        return False, "Organization validation not configured"
    
    # Check cache first
    _cleanup_org_validation_cache()
    if open_id in _org_validation_cache:
        cached = _org_validation_cache[open_id]
        result = cached.get("is_people_support_descendant", False)
        reason = cached.get("reason", "")
        logger.info(f"Org validation result from cache for {open_id[:10]}: {result}")
        return result, reason
    
    if not tenant_token:
        tenant_token = get_tenant_access_token()
    
    if not tenant_token:
        logger.warning(f"Cannot validate org: No tenant access token for {open_id[:10]}")
        return False, "Failed to get Lark tenant token"
    
    # Get user's department IDs
    dept_info = get_user_department_info(open_id)
    if not dept_info.get("success"):
        logger.warning(f"Failed to get user departments for {open_id[:10]}: {dept_info.get('error')}")
        return False, "Failed to retrieve user's department information"
    
    user_dept_ids = dept_info.get("department_ids", [])
    logger.info(f"User {open_id[:10]} belongs to departments: {user_dept_ids}")
    
    # Check each department
    for dept_id in user_dept_ids:
        # Check if this IS the target department
        if dept_id == TARGET_LARK_DEPARTMENT_ID:
            logger.info(f"User {open_id[:10]} is directly in People Support department (ID: {TARGET_LARK_DEPARTMENT_ID})")
            _org_validation_cache[open_id] = {
                "is_people_support_descendant": True,
                "reason": f"User in People Support department",
                "expires": time.time() + _ORG_CACHE_EXPIRY_SECONDS
            }
            return True, "User in People Support department"
        
        # Check if target is an ancestor of this department
        # Walk up from current dept to root, checking if we encounter target
        current = dept_id
        max_depth = 10
        
        while current and max_depth > 0:
            if current == TARGET_LARK_DEPARTMENT_ID:
                logger.info(f"User {open_id[:10]} is under People Support (via {dept_id})")
                _org_validation_cache[open_id] = {
                    "is_people_support_descendant": True,
                    "reason": f"User under People Support department",
                    "expires": time.time() + _ORG_CACHE_EXPIRY_SECONDS
                }
                return True, "User under People Support department"
            
            # Get parent department
            url = f"{DEPARTMENT_URL}/{current}?department_id_type=open_department_id"
            headers = {"Authorization": f"Bearer {tenant_token}"}
            response = _make_request(url, method="GET", headers=headers)
            
            if response.get("code") != 0:
                break
            
            parent_id = response.get("data", {}).get("department", {}).get("parent_department_id")
            if not parent_id or parent_id == "0":
                break  # Reached root
            
            current = parent_id
            max_depth -= 1
    
    # User is not in the required org hierarchy
    logger.warning(f"User {open_id[:10]} not in People Support department hierarchy. Depts: {user_dept_ids}")
    _org_validation_cache[open_id] = {
        "is_people_support_descendant": False,
        "reason": "User not in People Support department hierarchy",
        "expires": time.time() + _ORG_CACHE_EXPIRY_SECONDS
    }
    return False, "User not in People Support department hierarchy"


# ============================================
# Complete OAuth Flow Helper
# ============================================
def complete_oauth_flow(code: str, state: str) -> Dict[str, Any]:
    """
    Complete the OAuth flow: validate state, exchange code, get user info.
    
    Args:
        code: Authorization code from callback
        state: State parameter from callback
    
    Returns:
        Dict containing user info and tokens, or error
    """
    # Validate state
    state_data = validate_state(state)
    if not state_data:
        return {"success": False, "error": "Invalid or expired state parameter (CSRF protection)"}
    
    code_verifier = state_data.get('code_verifier')
    redirect_uri = state_data.get('redirect_uri')
    
    # Exchange code for tokens
    token_result = exchange_code_for_tokens(code, code_verifier, redirect_uri)
    if not token_result.get("success"):
        return token_result
    
    # Get user info
    user_result = get_user_info(token_result["access_token"])
    if not user_result.get("success"):
        return user_result
    
    # Get employee_no from Contact API (basic user_info API doesn't return it)
    employee_no = user_result.get("employee_no")
    if not employee_no and user_result.get("open_id"):
        employee_no = get_employee_no_from_contact_api(user_result.get("open_id"))
    
    # Combine results
    return {
        "success": True,
        "user": {
            "user_id": user_result.get("user_id"),
            "open_id": user_result.get("open_id"),
            "name": user_result.get("name"),
            "email": user_result.get("email"),
            "avatar_url": user_result.get("avatar_url"),
            "tenant_key": user_result.get("tenant_key"),
            "employee_no": employee_no,  # Employee Number from Contact API
            "mobile": user_result.get("mobile"),  # Personal Number from Lark
        },
        "tokens": {
            "access_token": token_result.get("access_token"),
            "refresh_token": token_result.get("refresh_token"),
            "expires_in": token_result.get("expires_in"),
        }
    }
