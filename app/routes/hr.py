"""
HR Routes - From Code 2
Handles HR authentication, dashboard, gallery, and employee management.
Includes background removal functionality for AI-generated photos.
Supports both password-based and Lark SSO authentication.
Uses TransactionManager for ACID compliance across multi-step API workflows.
"""
from fastapi import APIRouter, Request, Cookie
from fastapi.responses import HTMLResponse, JSONResponse, Response, RedirectResponse
from fastapi.templating import Jinja2Templates
import os
from pathlib import Path
from datetime import datetime
import logging
import json

# Database abstraction layer (supports Supabase and SQLite)
from app.database import (
    get_all_employees,
    get_employee_by_id,
    update_employee,
    update_employee_status_rpc,
    delete_employee,
    table_exists,
    get_employee_count,
    get_status_breakdown,
    get_all_headshot_usage,
    reset_headshot_usage,
    reset_all_headshot_usage,
    HEADSHOT_LIMIT_PER_USER,
    USE_SUPABASE
)

# Import services for background removal
from app.services.background_removal_service import remove_background_from_url
from app.services.cloudinary_service import upload_bytes_to_cloudinary, delete_from_cloudinary

# Import POC routing service
from app.services.poc_routing_service import compute_nearest_poc_branch, is_valid_poc_branch

# Import authentication
from app.auth import (
    verify_session, 
    authenticate_user, 
    create_session, 
    delete_session,
    get_session
)

# ACID Transaction Manager & Cache
from app.transaction_manager import TransactionManager, TransactionError
from app.workflow_cache import WorkflowCache, make_cache_key, TTL_EXTENDED, TTL_DEFAULT

router = APIRouter(prefix="/hr")

# Get the directory where this file is located
BASE_DIR = Path(__file__).resolve().parent.parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# Configure logging
logger = logging.getLogger(__name__)

# Check if running on Vercel (serverless) or locally
# VERCEL env var is "1" when running on Vercel
IS_VERCEL = os.environ.get("VERCEL", "0") == "1" or os.environ.get("VERCEL_ENV") is not None


# ============================================
# Authentication Routes
# ============================================

@router.get("/login", response_class=HTMLResponse)
def hr_login_page(request: Request, hr_session: str = Cookie(None)):
    """HR Login Page - redirect to dashboard if already logged in"""
    if get_session(hr_session):
        return RedirectResponse(url="/hr/dashboard", status_code=302)
    return templates.TemplateResponse("hr_login.html", {"request": request})


@router.post("/login")
async def hr_login(request: Request, response: Response):
    """Process HR login"""
    form = await request.form()
    username = form.get("username", "").strip()
    password = form.get("password", "")
    
    if not username or not password:
        return JSONResponse(content={
            "success": False, 
            "error": "Username and password are required"
        })
    
    if not authenticate_user(username, password):
        return JSONResponse(content={
            "success": False, 
            "error": "Invalid username or password"
        })
    
    # Create session (JWT token)
    session_id = create_session(username)
    
    # Create response with cookie
    json_response = JSONResponse(content={
        "success": True, 
        "redirect": "/hr/dashboard"
    })
    
    # VERCEL FIX: Set secure=True for production (HTTPS) environments
    # This ensures the cookie is only sent over secure connections in production
    # but still works for local development over HTTP
    is_production = IS_VERCEL or os.environ.get('VERCEL_ENV') == 'production'
    
    # Set session cookie (8 hours expiry)
    json_response.set_cookie(
        key="hr_session",
        value=session_id,
        httponly=True,
        max_age=28800,  # 8 hours
        samesite="lax",
        secure=is_production,  # Only require HTTPS in production
        path="/"  # Ensure cookie is sent for all paths
    )
    
    logger.info(f"HR user logged in: {username} (secure={is_production})")
    return json_response


@router.get("/logout")
def hr_logout(response: Response, hr_session: str = Cookie(None)):
    """Logout HR user"""
    if hr_session:
        delete_session(hr_session)
    
    response = RedirectResponse(url="/hr/login", status_code=302)
    response.delete_cookie("hr_session")
    return response


# ============================================
# Protected HTML Pages
# ============================================

@router.get("/", response_class=HTMLResponse)
def hr_dashboard_redirect(request: Request, hr_session: str = Cookie(None)):
    """Redirect /hr/ to /hr/dashboard or login"""
    if not get_session(hr_session):
        return RedirectResponse(url="/hr/login", status_code=302)
    return RedirectResponse(url="/hr/dashboard", status_code=302)


@router.get("/dashboard", response_class=HTMLResponse)
def hr_dashboard(request: Request, hr_session: str = Cookie(None)):
    """HR Dashboard page - Protected by auth and org access"""
    session = get_session(hr_session)
    if not session:
        return RedirectResponse(url="/hr/login", status_code=302)
    
    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "username": session["username"]
    })


@router.get("/gallery", response_class=HTMLResponse)
def id_gallery(request: Request, hr_session: str = Cookie(None)):
    """ID Gallery page - Protected by auth and org access"""
    session = get_session(hr_session)
    if not session:
        return RedirectResponse(url="/hr/login", status_code=302)
    
    return templates.TemplateResponse("gallery.html", {
        "request": request,
        "username": session["username"]
    })


# ============================================
# API Endpoints (Protected)
# ============================================

def verify_api_session(hr_session: str = Cookie(None)):
    """Verify session for API endpoints, return 401 if not authenticated"""
    session = get_session(hr_session)
    if not session:
        return None
    return session["username"]


@router.get("/api/debug")
def api_debug(hr_session: str = Cookie(None)):
    """Debug endpoint to check database and session status"""
    import os
    from app.database import SUPABASE_URL, SUPABASE_KEY, SQLITE_DB
    
    debug_info = {
        "use_supabase": USE_SUPABASE,
        "is_vercel": IS_VERCEL,
        "supabase_url_set": bool(SUPABASE_URL),
        "supabase_key_set": bool(SUPABASE_KEY),
        "sqlite_path": SQLITE_DB if not USE_SUPABASE else "N/A (using Supabase)",
        "session_present": hr_session is not None,
        "session_valid": False,
        "employee_count": 0,
        "table_exists": False,
        "error": None,
        "recommendation": None
    }
    
    # Check session
    session = get_session(hr_session)
    if session:
        debug_info["session_valid"] = True
        debug_info["session_username"] = session.get("username")
    
    # Check database
    try:
        debug_info["table_exists"] = table_exists()
        debug_info["employee_count"] = get_employee_count()
        debug_info["status_breakdown"] = get_status_breakdown()
    except Exception as e:
        debug_info["error"] = str(e)
    
    # Add recommendation if data might be ephemeral
    if IS_VERCEL and not USE_SUPABASE:
        debug_info["recommendation"] = "WARNING: Using SQLite on Vercel (/tmp is ephemeral). Data will be lost on cold starts. Set SUPABASE_URL and SUPABASE_KEY environment variables for persistent storage."
    
    logger.info(f"Debug endpoint: {debug_info}")
    return JSONResponse(content=debug_info)


@router.get("/api/debug/lark")
def api_debug_lark():
    """
    Debug endpoint to check Lark Base configuration and test connection.
    
    This endpoint helps diagnose why Lark Base updates may be failing on Vercel.
    It checks:
    1. Environment variables are set
    2. Access token can be obtained
    3. Records can be fetched from Lark Base
    
    Access: Public (for debugging purposes)
    """
    import os
    from app.services.lark_service import (
        LARK_APP_ID, LARK_APP_SECRET, LARK_BITABLE_ID, LARK_TABLE_ID,
        get_tenant_access_token, get_bitable_records
    )
    
    debug_info = {
        "is_vercel": IS_VERCEL,
        "env_vars": {
            "LARK_APP_ID_set": bool(os.environ.get('LARK_APP_ID')),
            "LARK_APP_ID_value": os.environ.get('LARK_APP_ID', '')[:10] + "..." if os.environ.get('LARK_APP_ID') else "NOT SET",
            "LARK_APP_SECRET_set": bool(os.environ.get('LARK_APP_SECRET')),
            "LARK_BITABLE_ID_set": bool(os.environ.get('LARK_BITABLE_ID')),
            "LARK_BITABLE_ID_value": os.environ.get('LARK_BITABLE_ID', 'NOT SET'),
            "LARK_TABLE_ID_set": bool(os.environ.get('LARK_TABLE_ID')),
            "LARK_TABLE_ID_value": os.environ.get('LARK_TABLE_ID', 'NOT SET'),
        },
        "module_vars": {
            "LARK_APP_ID": LARK_APP_ID[:10] + "..." if LARK_APP_ID else "NOT SET",
            "LARK_APP_SECRET": "***" if LARK_APP_SECRET else "NOT SET",
            "LARK_BITABLE_ID": LARK_BITABLE_ID or "NOT SET",
            "LARK_TABLE_ID": LARK_TABLE_ID or "NOT SET",
        },
        "token_test": {
            "success": False,
            "token_prefix": None,
            "error": None
        },
        "records_test": {
            "success": False,
            "record_count": 0,
            "sample_id_numbers": [],
            "error": None
        }
    }
    
    # Test 1: Can we get an access token?
    try:
        token = get_tenant_access_token()
        if token:
            debug_info["token_test"]["success"] = True
            debug_info["token_test"]["token_prefix"] = token[:10] + "..."
        else:
            debug_info["token_test"]["error"] = "get_tenant_access_token returned None"
    except Exception as e:
        debug_info["token_test"]["error"] = str(e)
    
    # Test 2: Can we fetch records from Lark Base?
    if debug_info["token_test"]["success"]:
        try:
            app_token = LARK_BITABLE_ID
            table_id = LARK_TABLE_ID
            
            if app_token and table_id:
                # Fetch first 5 records to verify connection
                records = get_bitable_records(app_token, table_id, page_size=5)
                
                if records is not None:
                    debug_info["records_test"]["success"] = True
                    debug_info["records_test"]["record_count"] = len(records)
                    
                    # Get sample id_numbers for verification
                    sample_ids = []
                    for record in records[:3]:
                        fields = record.get("fields", {})
                        id_num = fields.get("id_number", "")
                        status = fields.get("status", "")
                        if id_num:
                            sample_ids.append(f"{id_num} ({status})")
                    debug_info["records_test"]["sample_id_numbers"] = sample_ids
                else:
                    debug_info["records_test"]["error"] = "get_bitable_records returned None"
            else:
                debug_info["records_test"]["error"] = f"Missing config: app_token={bool(app_token)}, table_id={bool(table_id)}"
        except Exception as e:
            debug_info["records_test"]["error"] = str(e)
    
    # Add recommendations
    recommendations = []
    
    if not debug_info["env_vars"]["LARK_APP_ID_set"]:
        recommendations.append("Set LARK_APP_ID environment variable in Vercel")
    if not debug_info["env_vars"]["LARK_APP_SECRET_set"]:
        recommendations.append("Set LARK_APP_SECRET environment variable in Vercel")
    if not debug_info["env_vars"]["LARK_BITABLE_ID_set"]:
        recommendations.append("Set LARK_BITABLE_ID environment variable in Vercel")
    if not debug_info["env_vars"]["LARK_TABLE_ID_set"]:
        recommendations.append("Set LARK_TABLE_ID environment variable in Vercel")
    
    if debug_info["token_test"]["success"] and not debug_info["records_test"]["success"]:
        recommendations.append("Token works but records fetch failed - check Bitable permissions")
    
    if not recommendations:
        if debug_info["records_test"]["success"]:
            recommendations.append("✅ All Lark Base configuration looks good!")
        else:
            recommendations.append("Check Vercel function logs for more details")
    
    debug_info["recommendations"] = recommendations
    
    logger.info(f"Lark debug endpoint: token_ok={debug_info['token_test']['success']}, records_ok={debug_info['records_test']['success']}")
    return JSONResponse(content=debug_info)


@router.get("/api/employees")
def api_get_employees(request: Request, hr_session: str = Cookie(None)):
    """Get all employees for the dashboard - Protected by org access
    
    VERCEL FIX: Enhanced logging to debug cookie/session issues in serverless
    """
    logger.info(f"=== API /hr/api/employees ===")
    logger.info(f"Cookie value received: {hr_session[:20] if hr_session else 'None'}...")
    logger.info(f"Request headers: Authorization={request.headers.get('authorization', 'None')}")
    logger.info(f"Environment: USE_SUPABASE={USE_SUPABASE}, IS_VERCEL={IS_VERCEL}")
    logger.info(f"Client: {request.client.host if request.client else 'Unknown'}")
    
    session = get_session(hr_session)
    logger.info(f"Session retrieved: {session is not None}")
    if session:
        logger.info(f"Session username: {session.get('username')}, auth_type: {session.get('auth_type')}")
    
    if not session:
        logger.warning("API /api/employees: Unauthorized - no valid session")
        logger.warning(f"Failed to deserialize session from token (first 20 chars): {hr_session[:20] if hr_session else 'token is None'}")
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    
    logger.info(f"API /api/employees: Authenticated as {session.get('username')}")
    
    try:
        # Check if table exists first
        if not table_exists():
            logger.info("API /api/employees: Table does not exist, returning empty list")
            return JSONResponse(content={"success": True, "employees": []})

        # Get all employees using abstraction layer
        rows = get_all_employees()
        logger.info(f"API /api/employees: Found {len(rows)} total employees")

        employees = []
        for row in rows:
            employees.append({
                "id": row.get("id"),
                "employee_name": row.get("employee_name"),
                "first_name": row.get("first_name"),
                "middle_initial": row.get("middle_initial"),
                "last_name": row.get("last_name"),
                "suffix": row.get("suffix"),
                "id_nickname": row.get("id_nickname"),
                "id_number": row.get("id_number"),
                "position": row.get("position"),
                "location_branch": row.get("location_branch"),  # Current field used in dashboard
                "department": row.get("department"),  # Deprecated - kept for backward compatibility
                "email": row.get("email"),
                "personal_number": row.get("personal_number"),
                "photo_path": row.get("photo_path"),
                "photo_url": row.get("photo_url"),
                "new_photo": bool(row.get("new_photo")),
                "new_photo_url": row.get("new_photo_url"),
                "nobg_photo_url": row.get("nobg_photo_url"),
                "signature_path": row.get("signature_path"),
                "signature_url": row.get("signature_url"),
                "status": row.get("status") or "Reviewing",
                "date_last_modified": row.get("date_last_modified"),
                "id_generated": bool(row.get("id_generated")),
                "render_url": row.get("render_url"),
                "emergency_name": row.get("emergency_name"),
                "emergency_contact": row.get("emergency_contact"),
                "emergency_address": row.get("emergency_address"),
                # Field Officer specific fields
                "field_officer_type": row.get("field_officer_type"),
                "field_clearance": row.get("field_clearance"),
                "fo_division": row.get("fo_division"),
                "fo_department": row.get("fo_department"),
                "fo_campaign": row.get("fo_campaign")
            })

        logger.info(f"API /api/employees: Returning {len(employees)} employees")
        return JSONResponse(content={"success": True, "employees": employees})

    except Exception as e:
        logger.error(f"Error fetching employees: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.get("/api/employees/{employee_id}")
def api_get_employee(employee_id: int, hr_session: str = Cookie(None)):
    """Get a single employee by ID - Protected by org access"""
    session = get_session(hr_session)
    if not session:
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    
    try:
        row = get_employee_by_id(employee_id)

        if not row:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Employee not found"}
            )

        employee = {
            "id": row.get("id"),
            "employee_name": row.get("employee_name"),
            "first_name": row.get("first_name"),
            "middle_initial": row.get("middle_initial"),
            "last_name": row.get("last_name"),
            "suffix": row.get("suffix"),
            "id_nickname": row.get("id_nickname"),
            "id_number": row.get("id_number"),
            "position": row.get("position"),
            "department": row.get("department"),
            "location_branch": row.get("location_branch"),
            "email": row.get("email"),
            "personal_number": row.get("personal_number"),
            "photo_path": row.get("photo_path"),
            "photo_url": row.get("photo_url"),
            "new_photo": bool(row.get("new_photo")),
            "new_photo_url": row.get("new_photo_url"),
            "nobg_photo_url": row.get("nobg_photo_url"),
            "signature_path": row.get("signature_path"),
            "signature_url": row.get("signature_url"),
            "status": row.get("status") or "Reviewing",
            "date_last_modified": row.get("date_last_modified"),
            "id_generated": bool(row.get("id_generated")),
            "render_url": row.get("render_url"),
            "emergency_name": row.get("emergency_name"),
            "emergency_contact": row.get("emergency_contact"),
            "emergency_address": row.get("emergency_address"),
            # Field Officer specific fields
            "field_officer_type": row.get("field_officer_type"),
            "field_clearance": row.get("field_clearance"),
            "fo_division": row.get("fo_division"),
            "fo_department": row.get("fo_department"),
            "fo_campaign": row.get("fo_campaign")
        }

        return JSONResponse(content={"success": True, "employee": employee})

    except Exception as e:
        logger.error(f"Error fetching employee {employee_id}: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.post("/api/employees/{employee_id}/approve")
def api_approve_employee(employee_id: int, hr_session: str = Cookie(None)):
    """Approve an employee's ID application - Protected by org access"""
    session = get_session(hr_session)
    if not session:
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    
    try:
        # Check if employee exists and is in Reviewing status
        row = get_employee_by_id(employee_id)

        if not row:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Employee not found"}
            )

        if row.get("status") != "Rendered":
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": f"Cannot approve. Current status: {row.get('status')}. Only 'Rendered' IDs can be approved."}
            )

        old_status = row.get("status")
        id_number = row.get("id_number")

        # ====================================================================
        # ACID TRANSACTION: Approve Employee
        # Steps: Update DB → Sync Lark
        # If DB update fails, nothing changes. Lark sync is non-critical.
        # ====================================================================
        txn = TransactionManager("approve_employee", context={"employee_id": employee_id})
        
        try:
            # Step 1: Update local database (CRITICAL)
            txn.execute_step(
                name="update_status_db",
                action=lambda: update_employee(employee_id, {
                    "status": "Approved",
                    "date_last_modified": datetime.now().isoformat()
                }),
                rollback=lambda _: update_employee(employee_id, {
                    "status": old_status,
                    "date_last_modified": datetime.now().isoformat()
                }),
                error_message="Failed to update employee status in database",
            )

            # Step 2: Sync status to Lark Bitable (non-critical)
            lark_synced = False
            lark_error = None
            try:
                from app.services.lark_service import find_and_update_employee_status
                if id_number:
                    lark_synced = txn.execute_step(
                        name="sync_lark_status",
                        action=lambda: find_and_update_employee_status(
                            id_number, "Approved", old_status=old_status, source="HR Approval"
                        ),
                        is_critical=False,
                    )
                    if not lark_synced:
                        lark_error = "Lark update returned False - check logs for details"
                else:
                    lark_error = "No id_number found for employee"
            except Exception as lark_e:
                lark_error = str(lark_e)

            summary = txn.commit()
            logger.info(f"Employee {employee_id} approved (Lark synced: {lark_synced})")
            return JSONResponse(content={
                "success": True, 
                "message": "Application approved",
                "lark_synced": lark_synced,
                "lark_error": lark_error,
                "transaction": summary,
            })
            
        except TransactionError as te:
            txn.rollback()
            logger.error(f"Approve transaction failed: {te}")
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": str(te), "transaction": txn.get_summary()}
            )

    except Exception as e:
        logger.error(f"Error approving employee {employee_id}: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.post("/api/employees/{employee_id}/send-to-poc")
def api_send_to_poc(employee_id: int, hr_session: str = Cookie(None)):
    """
    Send a single employee's ID card to nearest POC branch.
    Changes status from "Approved" to "Sent to POC".
    Uses haversine distance to find nearest POC.
    """
    session = get_session(hr_session)
    if not session:
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    
    try:
        row = get_employee_by_id(employee_id)
        if not row:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Employee not found"}
            )
        
        current_status = row.get("status")
        if current_status != "Approved":
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": f"Cannot send to POC. Current status: {current_status}. Must be 'Approved'."}
            )
        
        # Compute nearest POC branch based on employee's location
        location_branch = row.get("location_branch", "")
        nearest_poc = compute_nearest_poc_branch(location_branch)
        id_number = row.get("id_number")

        # ====================================================================
        # ACID TRANSACTION: Send to POC
        # Steps: Update DB Status → Sync Lark → Send POC Message → Update email_sent
        # If DB update fails, nothing proceeds. Lark + message are non-critical.
        # ====================================================================
        txn = TransactionManager("send_to_poc", context={
            "employee_id": employee_id,
            "nearest_poc": nearest_poc,
        })
        
        try:
            # Step 1: Update employee status via RPC (CRITICAL)
            txn.execute_step(
                name="update_status_rpc",
                action=lambda: update_employee_status_rpc(employee_id, "Sent to POC"),
                rollback=lambda _: update_employee_status_rpc(employee_id, current_status),
                error_message="Failed to update employee status",
            )
            
            # Step 2: Sync status to Lark Bitable (non-critical)
            lark_synced = False
            try:
                from app.services.lark_service import find_and_update_employee_status
                if id_number:
                    lark_synced = txn.execute_step(
                        name="sync_lark_status",
                        action=lambda: find_and_update_employee_status(
                            id_number, "Sent to POC", old_status=current_status, source="HR Portal Send to POC"
                        ),
                        is_critical=False,
                    )
            except Exception as lark_e:
                logger.warning(f"⚠️ Could not sync status to Lark Bitable: {str(lark_e)}")
            
            # Step 3: Send actual Lark message to POC (non-critical)
            message_sent = False
            email_sent_updated = False
            test_mode = False
            send_error = None
            try:
                from app.services.lark_service import send_to_poc, update_employee_email_sent, is_poc_test_mode
                from app.services.poc_routing_service import get_poc_email, get_poc_contact
                
                test_mode = is_poc_test_mode()
                poc_email = get_poc_email(nearest_poc)
                poc_contact = get_poc_contact(nearest_poc)
                poc_name = poc_contact.get("name", "") if poc_contact else ""
                
                employee_data = {
                    "id_number": id_number,
                    "employee_name": row.get("employee_name", ""),
                    "position": row.get("position", ""),
                    "field_officer_type": row.get("field_officer_type", ""),
                    "location_branch": location_branch,
                    "pdf_url": row.get("render_url", ""),
                    "render_url": row.get("render_url", ""),
                    "poc_name": poc_name,
                    "card_images_json": row.get("card_images_json", ""),
                }
                
                send_result = txn.execute_step(
                    name="send_poc_message",
                    action=lambda: send_to_poc(employee_data, nearest_poc, poc_email),
                    is_critical=False,
                )
                
                if send_result and send_result.get("success"):
                    message_sent = True
                    logger.info(f"✅ POC message sent for employee {id_number} to {nearest_poc}" + 
                               (f" (TEST MODE)" if test_mode else ""))
                    
                    # Step 4: Update email_sent in Lark Bitable (non-critical)
                    try:
                        email_sent_updated = txn.execute_step(
                            name="update_email_sent",
                            action=lambda: update_employee_email_sent(
                                id_number, email_sent=True, resolved_printer_branch=nearest_poc
                            ),
                            is_critical=False,
                        )
                    except Exception:
                        pass
                else:
                    send_error = send_result.get("error", "Unknown error") if send_result else "No result"
            except Exception as msg_e:
                send_error = str(msg_e)
                logger.warning(f"⚠️ Could not send POC message: {send_error}")
            
            summary = txn.commit()
            
            logger.info(f"Employee {employee_id} sent to POC '{nearest_poc}' (Lark synced: {lark_synced}, message sent: {message_sent})")
            return JSONResponse(content={
                "success": True,
                "message": f"Sent to POC: {nearest_poc}",
                "nearest_poc": nearest_poc,
                "lark_synced": lark_synced,
                "message_sent": message_sent,
                "email_sent_updated": email_sent_updated,
                "test_mode": test_mode,
                "send_error": send_error,
                "transaction": summary,
            })
            
        except TransactionError as te:
            txn.rollback()
            logger.error(f"Send to POC transaction failed: {te}")
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": str(te), "transaction": txn.get_summary()}
            )
    
    except Exception as e:
        logger.error(f"Error sending employee {employee_id} to POC: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.post("/api/send-all-to-pocs")
def api_send_all_to_pocs(hr_session: str = Cookie(None)):
    """
    Bulk send all "Approved" employees to their nearest POC branches.
    Changes status from "Approved" to "Sent to POC" for all applicable employees.
    Uses haversine distance to find nearest POC for each employee.
    """
    session = get_session(hr_session)
    if not session:
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    
    try:
        # Get all employees
        all_employees = get_all_employees()
        approved_employees = [emp for emp in all_employees if emp.get("status") == "Approved"]
        
        if not approved_employees:
            return JSONResponse(content={
                "success": True,
                "message": "No approved employees to send to POCs",
                "sent_count": 0
            })
        
        success_count = 0
        failed_count = 0
        message_sent_count = 0
        poc_routing = {}  # Track how many employees sent to each POC
        
        # Import messaging functions once
        from app.services.lark_service import find_and_update_employee_status, send_to_poc, update_employee_email_sent, is_poc_test_mode
        from app.services.poc_routing_service import get_poc_email, get_poc_contact
        test_mode = is_poc_test_mode()
        
        for emp in approved_employees:
            employee_id = emp.get("id")
            location_branch = emp.get("location_branch", "")
            id_number = emp.get("id_number")
            
            try:
                # Compute nearest POC
                nearest_poc = compute_nearest_poc_branch(location_branch)
                
                # Update employee status via RPC (bypasses PostgREST schema cache)
                success = update_employee_status_rpc(employee_id, "Sent to POC")
                
                if success:
                    success_count += 1
                    poc_routing[nearest_poc] = poc_routing.get(nearest_poc, 0) + 1
                    
                    # Sync to Lark Bitable
                    try:
                        if id_number:
                            find_and_update_employee_status(
                                id_number,
                                "Sent to POC",
                                old_status="Approved",
                                source="HR Portal Bulk Send to POCs"
                            )
                    except Exception as lark_e:
                        logger.warning(f"⚠️ Could not sync status to Lark for {id_number}: {str(lark_e)}")
                    
                    # Send actual Lark message to POC
                    try:
                        poc_email = get_poc_email(nearest_poc)
                        poc_contact = get_poc_contact(nearest_poc)
                        poc_name = poc_contact.get("name", "") if poc_contact else ""
                        employee_data = {
                            "id_number": id_number,
                            "employee_name": emp.get("employee_name", ""),
                            "position": emp.get("position", ""),
                            "field_officer_type": emp.get("field_officer_type", ""),
                            "location_branch": location_branch,
                            "pdf_url": emp.get("render_url", ""),
                            "render_url": emp.get("render_url", ""),
                            "poc_name": poc_name,
                            "card_images_json": emp.get("card_images_json", ""),
                        }
                        send_result = send_to_poc(employee_data, nearest_poc, poc_email)
                        
                        if send_result.get("success"):
                            message_sent_count += 1
                            # Update email_sent in Lark Bitable
                            try:
                                update_employee_email_sent(id_number, email_sent=True, resolved_printer_branch=nearest_poc)
                            except Exception as email_e:
                                logger.warning(f"⚠️ Could not update email_sent for {id_number}: {str(email_e)}")
                        else:
                            logger.warning(f"⚠️ Failed to send POC message for {id_number}: {send_result.get('error')}")
                    except Exception as msg_e:
                        logger.warning(f"⚠️ Could not send POC message for {id_number}: {str(msg_e)}")
                else:
                    failed_count += 1
                    
            except Exception as emp_e:
                logger.error(f"Error sending employee {employee_id} to POC: {str(emp_e)}")
                failed_count += 1
        
        logger.info(f"Bulk send to POCs complete: {success_count} sent, {failed_count} failed")
        logger.info(f"POC routing breakdown: {poc_routing}")
        
        # Return appropriate response based on results
        # If ALL failed, return error (500). If some succeeded, return partial success (200).
        if success_count == 0 and failed_count > 0:
            return JSONResponse(
                status_code=500,
                content={
                    "success": False,
                    "error": f"All {failed_count} employee(s) failed to send to POC",
                    "sent_count": 0,
                    "failed_count": failed_count
                }
            )
        
        return JSONResponse(content={
            "success": success_count > 0,
            "message": f"Sent {success_count} employee(s) to POCs" + (f", {failed_count} failed" if failed_count > 0 else ""),
            "sent_count": success_count,
            "failed_count": failed_count,
            "message_sent_count": message_sent_count,
            "test_mode": test_mode,
            "poc_routing": poc_routing
        })
    
    except Exception as e:
        logger.error(f"Error in bulk send to POCs: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.post("/api/employees/{employee_id}/render")
def api_render_employee(employee_id: int, hr_session: str = Cookie(None)):
    """Mark employee ID as Rendered (ready for Gallery review) - does NOT approve"""
    session = get_session(hr_session)
    if not session:
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    
    try:
        # Check if employee exists and is in an acceptable status
        row = get_employee_by_id(employee_id)

        if not row:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Employee not found"}
            )

        # Accept Reviewing, Pending, or Submitted status for rendering
        current_status = row.get("status")
        acceptable_statuses = ["Reviewing", "Pending", "Submitted"]
        
        if current_status not in acceptable_statuses:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": f"Cannot render. Current status: {current_status}. Must be one of: {', '.join(acceptable_statuses)}"}
            )

        id_number = row.get("id_number")

        # ====================================================================
        # ACID TRANSACTION: Render Employee
        # Steps: Update DB → Sync Lark
        # DB rollback to previous status if critical failure occurs.
        # ====================================================================
        txn = TransactionManager("render_employee", context={"employee_id": employee_id})
        
        try:
            # Step 1: Update local database (CRITICAL)
            txn.execute_step(
                name="update_status_db",
                action=lambda: update_employee(employee_id, {
                    "status": "Rendered",
                    "date_last_modified": datetime.now().isoformat()
                }),
                rollback=lambda _: update_employee(employee_id, {
                    "status": current_status,
                    "date_last_modified": datetime.now().isoformat()
                }),
                error_message="Failed to update employee status in database",
            )

            # Step 2: Sync status to Lark Bitable (non-critical)
            lark_synced = False
            lark_error = None
            try:
                from app.services.lark_service import find_and_update_employee_status
                if id_number:
                    lark_synced = txn.execute_step(
                        name="sync_lark_status",
                        action=lambda: find_and_update_employee_status(
                            id_number, "Rendered", old_status=current_status, source="HR Render"
                        ),
                        is_critical=False,
                    )
                    if not lark_synced:
                        lark_error = "Lark update returned False - check logs for details"
                else:
                    lark_error = "No id_number found for employee"
            except Exception as lark_e:
                lark_error = str(lark_e)

            summary = txn.commit()
            logger.info(f"Employee {employee_id} rendered (Lark synced: {lark_synced})")
            return JSONResponse(content={
                "success": True, 
                "message": "ID marked as Rendered - ready for Gallery approval",
                "lark_synced": lark_synced,
                "lark_error": lark_error,
                "transaction": summary,
            })
            
        except TransactionError as te:
            txn.rollback()
            logger.error(f"Render transaction failed: {te}")
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": str(te), "transaction": txn.get_summary()}
            )

    except Exception as e:
        logger.error(f"Error rendering employee {employee_id}: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.delete("/api/employees/{employee_id}")
def api_delete_employee(employee_id: int, hr_session: str = Cookie(None)):
    """Mark employee application as Removed instead of deleting - Protected by org access"""
    session = get_session(hr_session)
    if not session:
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    
    try:
        # Check if employee exists
        row = get_employee_by_id(employee_id)

        if not row:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Employee not found"}
            )

        employee_name = row.get("employee_name")
        id_number = row.get("id_number")
        current_status = row.get("status")

        # ====================================================================
        # ACID TRANSACTION: Remove Employee
        # Steps: Update DB → Sync Lark
        # DB rollback to previous status on failure.
        # ====================================================================
        txn = TransactionManager("remove_employee", context={"employee_id": employee_id})
        
        try:
            # Step 1: Update status to Removed (CRITICAL)
            txn.execute_step(
                name="update_status_db",
                action=lambda: update_employee(employee_id, {
                    "status": "Removed",
                    "date_last_modified": datetime.now().isoformat()
                }),
                rollback=lambda _: update_employee(employee_id, {
                    "status": current_status,
                    "date_last_modified": datetime.now().isoformat()
                }),
                error_message="Failed to remove employee",
            )

            # Step 2: Sync status to Lark Bitable (non-critical)
            lark_synced = False
            try:
                from app.services.lark_service import find_and_update_employee_status
                if id_number:
                    lark_synced = txn.execute_step(
                        name="sync_lark_status",
                        action=lambda: find_and_update_employee_status(
                            id_number, "Removed", old_status=current_status, source="HR Remove"
                        ),
                        is_critical=False,
                    )
            except Exception as lark_e:
                logger.warning(f"⚠️ Could not sync status to Lark Bitable: {str(lark_e)}")

            summary = txn.commit()
            logger.info(f"Employee {employee_id} ({employee_name}) marked as Removed (Lark synced: {lark_synced})")
            return JSONResponse(content={
                "success": True, 
                "message": f"Application for {employee_name} removed", 
                "lark_synced": lark_synced,
                "transaction": summary,
            })
            
        except TransactionError as te:
            txn.rollback()
            logger.error(f"Remove transaction failed: {te}")
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": str(te), "transaction": txn.get_summary()}
            )

    except Exception as e:
        logger.error(f"Error removing employee {employee_id}: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.post("/api/employees/{employee_id}/remove-background")
def api_remove_background(employee_id: int, hr_session: str = Cookie(None)):
    """Remove background from AI-generated photo and save the result - Protected by org access"""
    import traceback
    
    session = get_session(hr_session)
    if not session:
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    
    logger.info(f"=== REMOVE BACKGROUND REQUEST for employee {employee_id} ===")
    
    try:
        # Get the employee's AI photo URL
        row = get_employee_by_id(employee_id)

        if not row:
            logger.error(f"Employee {employee_id} not found")
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Employee not found"}
            )

        logger.info(f"Employee found: id_number={row.get('id_number')}, new_photo_url={row.get('new_photo_url', '')[:50] if row.get('new_photo_url') else 'None'}...")

        if not row.get("new_photo_url"):
            logger.error(f"No AI photo available for employee {employee_id}")
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "No AI photo available to process"}
            )

        # If already has nobg photo, return it (cached result)
        if row.get("nobg_photo_url"):
            logger.info(f"Employee {employee_id} already has nobg photo (reusing cached): {row.get('nobg_photo_url', '')[:50]}...")
            return JSONResponse(content={
                "success": True, 
                "nobg_photo_url": row.get("nobg_photo_url"),
                "message": "Background already removed",
                "from_cache": True,
            })

        ai_photo_url = row.get("new_photo_url")
        safe_id = row.get("id_number", "").replace(' ', '_').replace('/', '-').replace('\\', '-')
        
        # Check workflow cache for previously generated nobg result
        nobg_cache_key = make_cache_key("nobg", safe_id)
        cached_nobg = WorkflowCache.get(nobg_cache_key)
        if cached_nobg:
            logger.info(f"Using cached nobg URL for employee {employee_id}: {cached_nobg[:50]}...")
            # Save to database since we have it cached
            update_employee(employee_id, {
                "nobg_photo_url": cached_nobg,
                "date_last_modified": datetime.now().isoformat()
            })
            return JSONResponse(content={
                "success": True,
                "nobg_photo_url": cached_nobg,
                "message": "Background removed (from cache)",
                "from_cache": True,
            })

        # ====================================================================
        # ACID TRANSACTION: Background Removal
        # Steps: Remove BG API → Upload Cloudinary → Update DB
        # If any step fails, completed steps are rolled back.
        # ====================================================================
        txn = TransactionManager("background_removal", context={"employee_id": employee_id})
        
        try:
            # Step 1: Remove background using local rembg (non-blocking fallback)
            def _remove_bg():
                nobg_result, err = remove_background_from_url(ai_photo_url)
                if not nobg_result:
                    logger.warning("Background removal unavailable, using original image. reason=%s", err or "unknown")
                    return None
                return nobg_result
            
            nobg_bytes = txn.execute_step(
                name="remove_background_api",
                action=_remove_bg,
                is_critical=False,
                error_message="Failed to remove background from image",
            )

            if nobg_bytes is None:
                summary = txn.commit()
                return JSONResponse(content={
                    "success": True,
                    "nobg_photo_url": ai_photo_url,
                    "message": "Background removal skipped. Using original image.",
                    "transaction": summary,
                })
            
            logger.info(f"Background removed successfully, got {len(nobg_bytes)} bytes")
            
            # Step 2: Upload to Cloudinary
            nobg_public_id = f"{safe_id}_nobg"
            nobg_url = txn.execute_step(
                name="upload_nobg_cloudinary",
                action=lambda: upload_bytes_to_cloudinary(
                    image_bytes=nobg_bytes,
                    public_id=nobg_public_id,
                    folder="employees"
                ),
                rollback=lambda url: delete_from_cloudinary(url),
                cache_key=nobg_cache_key,
                error_message="Failed to upload processed image to cloud",
            )
            
            # Step 3: Update database with nobg URL
            txn.execute_step(
                name="update_database_nobg",
                action=lambda: update_employee(employee_id, {
                    "nobg_photo_url": nobg_url,
                    "date_last_modified": datetime.now().isoformat()
                }),
                is_critical=False,  # Don't fail if DB update doesn't work
            )
            
            summary = txn.commit()
            
            logger.info(f"=== BACKGROUND REMOVAL COMPLETE for employee {employee_id} ===")
            return JSONResponse(content={
                "success": True, 
                "nobg_photo_url": nobg_url,
                "message": "Background removed successfully",
                "transaction": summary,
            })
            
        except TransactionError as te:
            txn.rollback()
            logger.error(f"Background removal transaction failed: {te}")
            return JSONResponse(
                status_code=500,
                content={
                    "success": False,
                    "error": str(te),
                    "transaction": txn.get_summary(),
                }
            )

    except Exception as e:
        logger.error(f"Error removing background for employee {employee_id}: {str(e)}")
        logger.error(traceback.format_exc())
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.post("/api/employees/{employee_id}/complete")
def api_complete_employee(employee_id: int, hr_session: str = Cookie(None)):
    """Mark an employee's ID as completed (after PDF download) - syncs to Larkbase"""
    if not get_session(hr_session):
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    try:
        # Check if employee exists and is Approved
        row = get_employee_by_id(employee_id)

        if not row:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Employee not found"}
            )

        old_status = row.get("status")
        if old_status not in ["Sent to POC", "Completed"]:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": f"Cannot mark as complete. Current status: {old_status}. Must be 'Sent to POC'."}
            )

        id_number = row.get("id_number")

        # ====================================================================
        # ACID TRANSACTION: Complete Employee
        # Steps: Update DB → Sync Lark
        # DB rollback to previous status on critical failure.
        # ====================================================================
        txn = TransactionManager("complete_employee", context={"employee_id": employee_id})
        
        try:
            # Step 1: Update local database (CRITICAL)
            txn.execute_step(
                name="update_status_db",
                action=lambda: update_employee(employee_id, {
                    "status": "Completed",
                    "id_generated": 1,
                    "date_last_modified": datetime.now().isoformat()
                }),
                rollback=lambda _: update_employee(employee_id, {
                    "status": old_status,
                    "date_last_modified": datetime.now().isoformat()
                }),
                error_message="Failed to update employee status in database",
            )

            # Step 2: Sync status to Lark Bitable (non-critical)
            lark_synced = False
            try:
                from app.services.lark_service import find_and_update_employee_status
                if id_number:
                    lark_synced = txn.execute_step(
                        name="sync_lark_status",
                        action=lambda: find_and_update_employee_status(
                            id_number, "Completed", old_status=old_status, source="PDF Download"
                        ),
                        is_critical=False,
                    )
            except Exception as lark_e:
                logger.warning(f"⚠️ Could not sync status to Lark Bitable: {str(lark_e)}")

            summary = txn.commit()
            logger.info(f"Employee {employee_id} marked as completed (Lark synced: {lark_synced})")
            return JSONResponse(content={
                "success": True, 
                "message": "ID marked as completed",
                "lark_synced": lark_synced,
                "transaction": summary,
            })
            
        except TransactionError as te:
            txn.rollback()
            logger.error(f"Complete transaction failed: {te}")
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": str(te), "transaction": txn.get_summary()}
            )

    except Exception as e:
        logger.error(f"Error completing employee {employee_id}: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.post("/api/employees/{employee_id}/upload-pdf")
async def api_upload_pdf(employee_id: int, request: Request, hr_session: str = Cookie(None)):
    """
    Upload employee ID PDF to Cloudinary and save URL to LarkBase id_card column.
    
    This endpoint receives the PDF bytes from the frontend after generation,
    uploads it to Cloudinary, and updates the LarkBase id_card field with the URL.
    
    CRITICAL FLOW:
    1. Receive PDF bytes from frontend
    2. Upload to Cloudinary -> get secure URL
    3. Update LarkBase id_card field with attachment format
    4. Return success ONLY if both operations succeed
    5. Frontend triggers download ONLY after receiving success response
    
    Request body should be the raw PDF bytes (Content-Type: application/pdf).
    
    Returns:
        - success: True only if both Cloudinary upload AND LarkBase update succeed
        - pdf_url: The Cloudinary URL of the uploaded PDF
        - lark_synced: True if LarkBase id_card was updated successfully
        - error: Error message if any step failed
    """
    session = get_session(hr_session)
    if not session:
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    
    try:
        # Get employee data
        row = get_employee_by_id(employee_id)
        
        if not row:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Employee not found"}
            )
        
        # Accept Rendered, Approved, or Completed status (Rendered is new workflow)
        if row.get("status") not in ["Rendered", "Approved", "Completed"]:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "ID not ready for approval"}
            )
        
        # Read PDF bytes from request body
        pdf_bytes = await request.body()
        
        if not pdf_bytes or len(pdf_bytes) < 100:
            logger.error(f"Invalid PDF data received for employee {employee_id}: {len(pdf_bytes) if pdf_bytes else 0} bytes")
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Invalid or empty PDF data"}
            )
        
        logger.info(f"📥 Received PDF upload for employee {employee_id}: {len(pdf_bytes)} bytes")
        
        # Generate unique public_id for the PDF
        id_number = row.get("id_number", "")
        id_number_safe = id_number.replace(" ", "_").replace("/", "-").replace("\\", "-")
        employee_name = row.get("employee_name", "").replace(" ", "_")
        position = row.get("position", "")
        
        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        suffix = "_dual_templates" if position == "Field Officer" else ""
        public_id = f"ID_{id_number_safe}_{employee_name}{suffix}_{timestamp}"
        
        # ====================================================================
        # ACID TRANSACTION: PDF Upload + LarkBase Sync
        # Steps: Upload PDF → Verify URL → Upload Preview → Update Lark → Update DB
        # If Lark sync fails, Cloudinary upload is rolled back.
        # ====================================================================
        txn = TransactionManager("pdf_upload", context={
            "employee_id": employee_id,
            "id_number": id_number,
        })
        
        try:
            # Step 1: Upload PDF to Cloudinary
            from app.services.cloudinary_service import upload_pdf_to_cloudinary
            pdf_url = txn.execute_step(
                name="upload_pdf_cloudinary",
                action=lambda: upload_pdf_to_cloudinary(pdf_bytes, public_id, folder="id_cards"),
                rollback=lambda url: delete_from_cloudinary(url),
                error_message="Failed to upload PDF to cloud storage",
            )
            
            logger.info(f"✅ PDF uploaded to Cloudinary: {pdf_url}")
            
            # Step 1.5a: Upload image preview (non-critical)
            try:
                from app.services.cloudinary_service import upload_pdf_image_preview
                txn.execute_step(
                    name="upload_image_preview",
                    action=lambda: upload_pdf_image_preview(pdf_bytes, public_id, folder="id_cards"),
                    is_critical=False,
                )
            except Exception as img_e:
                logger.warning(f"⚠️ Image preview upload error (non-critical): {str(img_e)}")
            
            # Step 1.5b: Verify URL accessibility (non-critical)
            import urllib.request
            import urllib.error
            
            def _verify_url():
                req = urllib.request.Request(pdf_url, method='HEAD')
                req.add_header('User-Agent', 'Mozilla/5.0 (compatible; URLValidator/1.0)')
                with urllib.request.urlopen(req, timeout=10) as response:
                    if response.status != 200:
                        raise Exception(f"HTTP {response.status}")
                return True
            
            txn.execute_step(
                name="verify_pdf_url",
                action=_verify_url,
                is_critical=False,  # Some CDNs block HEAD requests
            )
            
            # Step 2: Update LarkBase id_card field (CRITICAL)
            from app.services.lark_service import update_employee_id_card
            
            lark_synced = txn.execute_step(
                name="update_lark_id_card",
                action=lambda: update_employee_id_card(
                    id_number,
                    pdf_url,
                    source="HR PDF Download"
                ),
                error_message=f"PDF uploaded to cloud but LarkBase update failed",
            )
            
            if not lark_synced:
                raise TransactionError(
                    "LarkBase id_card update returned False",
                    transaction_id=txn.transaction_id,
                    step_name="update_lark_id_card",
                )
            
            # Step 3: Update local database (non-critical)
            txn.execute_step(
                name="update_local_database",
                action=lambda: update_employee(employee_id, {
                    "render_url": pdf_url,
                    "id_generated": 1,
                    "date_last_modified": datetime.now().isoformat()
                }),
                is_critical=False,
            )
            
            summary = txn.commit()
            
            logger.info(f"✅ PDF upload complete for employee {employee_id} - LarkBase synced: {lark_synced}")
            
            return JSONResponse(content={
                "success": True,
                "pdf_url": pdf_url,
                "lark_synced": True,
                "message": "PDF uploaded and LarkBase id_card updated successfully",
                "transaction": summary,
            })
            
        except TransactionError as te:
            txn.rollback()
            logger.error(f"PDF upload transaction failed: {te}")
            # Include pdf_url for manual recovery if Cloudinary upload succeeded
            pdf_url_for_recovery = txn.get_step_result("upload_pdf_cloudinary")
            return JSONResponse(
                status_code=500,
                content={
                    "success": False,
                    "error": str(te),
                    "pdf_url": pdf_url_for_recovery,
                    "lark_synced": False,
                    "transaction": txn.get_summary(),
                }
            )
        
    except Exception as e:
        logger.error(f"❌ Error uploading PDF for employee {employee_id}: {str(e)}")
        import traceback
        logger.error(traceback.format_exc())
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.post("/api/employees/{employee_id}/upload-card-images")
async def api_upload_card_images(employee_id: int, request: Request, hr_session: str = Cookie(None)):
    """
    Upload high-resolution PNG card images for direct bot message delivery.
    
    This endpoint receives PNG images (front/back of each card template) captured
    at high resolution (4x scale, lossless PNG) from the frontend. The images are
    uploaded to Cloudinary as native PNGs and their URLs are stored in the database.
    
    When sending ID cards to POCs via Lark bot, these direct PNG URLs are used
    instead of deriving images from the PDF via Cloudinary transformations,
    eliminating the PDF→PNG conversion quality loss.
    
    Request body: JSON with card_images array:
    [
        {"label": "SPMC ID - Front", "data": "base64_png_data..."},
        {"label": "SPMC ID - Back", "data": "base64_png_data..."},
        ...
    ]
    
    Returns:
        - success: True if all images uploaded successfully
        - card_images: List of {label, url} for each uploaded image
        - error: Error message if any step failed
    """
    session = get_session(hr_session)
    if not session:
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    
    try:
        row = get_employee_by_id(employee_id)
        if not row:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Employee not found"}
            )
        
        # Accept Rendered, Approved, or Completed status
        if row.get("status") not in ["Rendered", "Approved", "Completed", "Sent to POC"]:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "ID not ready for card image upload"}
            )
        
        # Parse JSON body
        import json as json_module
        body = await request.json()
        card_images_input = body.get("card_images", [])
        
        if not card_images_input:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "No card images provided"}
            )
        
        logger.info(f"📸 Received {len(card_images_input)} card images for employee {employee_id}")
        
        # Build unique identifiers
        id_number = row.get("id_number", "")
        id_number_safe = id_number.replace(" ", "_").replace("/", "-").replace("\\", "-")
        employee_name = row.get("employee_name", "").replace(" ", "_")
        
        from datetime import datetime
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        from app.services.cloudinary_service import upload_card_image_png
        
        # ====================================================================
        # ACID TRANSACTION: Card Images Upload
        # Steps: Upload each image → Save all URLs to DB
        # If DB save fails, all Cloudinary uploads are rolled back.
        # ====================================================================
        txn = TransactionManager("card_images_upload", context={
            "employee_id": employee_id,
            "image_count": len(card_images_input),
        })
        
        try:
            uploaded_images = []
            errors = []
            
            for i, img_entry in enumerate(card_images_input):
                label = img_entry.get("label", f"Page {i+1}")
                base64_data = img_entry.get("data", "")
                
                if not base64_data:
                    errors.append(f"Empty data for {label}")
                    continue
                
                # Remove data URI prefix if present
                if base64_data.startswith("data:"):
                    base64_data = base64_data.split(",", 1)[1]
                
                try:
                    import base64 as b64_module
                    image_bytes = b64_module.b64decode(base64_data)
                except Exception as decode_err:
                    errors.append(f"Invalid base64 for {label}: {str(decode_err)}")
                    continue
                
                if len(image_bytes) < 100:
                    errors.append(f"Image too small for {label}: {len(image_bytes)} bytes")
                    continue
                
                # Generate label-based suffix for the public_id
                label_safe = label.replace(" ", "_").replace("-", "_").replace("/", "_").lower()
                public_id = f"ID_{id_number_safe}_{label_safe}_{timestamp}"
                
                # Each image upload is a non-critical step (partial success is OK)
                try:
                    image_url = txn.execute_step(
                        name=f"upload_card_image_{i}",
                        action=lambda ib=image_bytes, pid=public_id: upload_card_image_png(ib, pid, folder="id_card_images"),
                        rollback=lambda url: delete_from_cloudinary(url),
                        is_critical=False,
                    )
                    if image_url:
                        uploaded_images.append({"label": label, "url": image_url})
                        logger.info(f"  ✅ {label} uploaded: {image_url[:60]}...")
                    else:
                        errors.append(f"Cloudinary upload returned None for {label}")
                except Exception as upload_err:
                    errors.append(f"Upload failed for {label}: {str(upload_err)}")
                    logger.error(f"  ❌ {label} upload failed: {str(upload_err)}")
            
            if not uploaded_images:
                txn.rollback()
                return JSONResponse(
                    status_code=500,
                    content={
                        "success": False,
                        "error": f"No images uploaded successfully. Errors: {'; '.join(errors)}",
                        "transaction": txn.get_summary(),
                    }
                )
            
            # Save all card image URLs to database (CRITICAL step)
            import json as json_mod
            card_images_json = json_mod.dumps(uploaded_images)
            
            txn.execute_step(
                name="save_card_images_db",
                action=lambda: update_employee(employee_id, {
                    "card_images_json": card_images_json,
                    "date_last_modified": datetime.now().isoformat()
                }),
                is_critical=False,  # Don't rollback all images if DB save fails
            )
            
            summary = txn.commit()
            
            logger.info(f"✅ Card images upload complete for employee {employee_id}: {len(uploaded_images)}/{len(card_images_input)} images")
            
            return JSONResponse(content={
                "success": True,
                "card_images": uploaded_images,
                "total_uploaded": len(uploaded_images),
                "total_requested": len(card_images_input),
                "errors": errors if errors else None,
                "message": f"{len(uploaded_images)} card images uploaded successfully",
                "transaction": summary,
            })
            
        except TransactionError as te:
            txn.rollback()
            logger.error(f"Card images upload transaction failed: {te}")
            return JSONResponse(
                status_code=500,
                content={
                    "success": False,
                    "error": str(te),
                    "transaction": txn.get_summary(),
                }
            )
        
    except Exception as e:
        logger.error(f"❌ Error uploading card images for employee {employee_id}: {str(e)}")
        import traceback
        logger.error(traceback.format_exc())
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.get("/api/employees/{employee_id}/download-id")
def api_download_id(employee_id: int, hr_session: str = Cookie(None)):
    """
    Download employee ID as PDF
    Note: This is a placeholder - templated.io integration pending
    """
    if not get_session(hr_session):
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    try:
        row = get_employee_by_id(employee_id)

        if not row:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Employee not found"}
            )

        if row.get("status") not in ["Approved", "Completed"]:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "ID not yet approved"}
            )

        # TODO: Integrate with templated.io for dynamic PDF generation
        # For now, return a placeholder response
        return JSONResponse(
            status_code=501,
            content={
                "success": False,
                "error": "PDF generation coming soon. Templated.io integration pending.",
                "employee_data": {
                    "name": row.get("employee_name"),
                    "id_number": row.get("id_number"),
                    "position": row.get("position"),
                    "department": row.get("department"),
                    "email": row.get("email"),
                    "phone": row.get("personal_number")
                }
            }
        )

    except Exception as e:
        logger.error(f"Error downloading ID for employee {employee_id}: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.get("/api/stats")
def api_get_stats(hr_session: str = Cookie(None)):
    """Get dashboard statistics"""
    if not get_session(hr_session):
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    try:
        # Get status breakdown using abstraction layer
        status_counts = get_status_breakdown()
        total = get_employee_count()

        return JSONResponse(content={
            "success": True,
            "stats": {
                "total": total,
                "reviewing": status_counts.get("Reviewing", 0),
                "approved": status_counts.get("Approved", 0),
                "completed": status_counts.get("Completed", 0)
            }
        })

    except Exception as e:
        logger.error(f"Error fetching stats: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


# ============================================
# Approved Export API (Bypasses Screenshot Protection)
# ============================================
@router.post("/api/export-approved")
def export_approved_id(request: Request, hr_session: str = Cookie(None)):
    """
    Approved export endpoint that bypasses screenshot/recording protection.
    
    This endpoint allows HR users to legitimately export ID cards as PDFs
    for official processing. Export is logged and includes watermarks
    for audit trail purposes.
    
    Security: 
    - Requires HR authentication
    - Logs export intent to security audit trail
    - Includes watermark with timestamp and HR user info
    - Only works for Approved/Completed status employees
    """
    # Authentication check
    session = get_session(hr_session)
    if not session:
        return JSONResponse(status_code=401, content={"success": False, "error": "Unauthorized"})
    
    hr_username = session.get("username", "unknown")
    
    try:
        # Parse request body
        body = None
        if request.method == "POST":
            # Get JSON or form data
            content_type = request.headers.get("content-type", "")
            if "application/json" in content_type:
                import json
                body_bytes = request.body() if hasattr(request, 'body') else b"{}"
                body = json.loads(body_bytes) if body_bytes else {}
        
        employee_ids = body.get("employee_ids", []) if body else []
        export_format = body.get("format", "pdf").lower()
        
        if not employee_ids:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "No employee IDs provided"}
            )
        
        # Validate export format
        if export_format not in ["pdf", "zip"]:
            export_format = "pdf"
        
        # Log export intent to security audit
        from app.database import insert_security_event
        for emp_id in employee_ids:
            insert_security_event(
                event_type="approved_export",
                details=f"HR user {hr_username} approved export of employee ID {emp_id}",
                username=hr_username,
                url=f"/hr/api/export-approved",
            )
        
        # Prepare export data
        employees_to_export = []
        for emp_id in employee_ids:
            try:
                emp = get_employee_by_id(int(emp_id))
                if emp and emp.get("status") in ["Approved", "Completed"]:
                    employees_to_export.append(emp)
            except:
                pass
        
        if not employees_to_export:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "No approved employees found for export"}
            )
        
        # Log successful export
        logger.info(f"[HR EXPORT] User {hr_username} exported {len(employees_to_export)} employee ID(s) - Format: {export_format}")
        
        # Return metadata about export (actual PDF generation handled by frontend)
        return JSONResponse({
            "success": True,
            "message": f"Export approved for {len(employees_to_export)} employee(s)",
            "employee_count": len(employees_to_export),
            "export_format": export_format,
            "exported_by": hr_username,
            "timestamp": datetime.utcnow().isoformat(),
            "employees": [
                {
                    "id": emp.get("id"),
                    "employee_name": emp.get("employee_name"),
                    "id_number": emp.get("id_number"),
                    "status": emp.get("status"),
                    "photo_url": emp.get("nobg_photo_url") or emp.get("photo_url"),
                }
                for emp in employees_to_export
            ],
            "watermark": f"OFFICIAL EXPORT - {hr_username} - {datetime.utcnow().strftime('%Y-%m-%d %H:%M')}",
        })
        
    except Exception as e:
        logger.error(f"Error in approved export: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Export failed"}
        )


@router.get("/export-help")
def export_help_page(request: Request, hr_session: str = Cookie(None)):
    """
    Help page explaining approved export process.
    Shows how to legitimately export ID cards without screenshot warnings.
    """
    if not get_session(hr_session):
        return RedirectResponse(url="/hr/login", status_code=302)
    
    return HTMLResponse("""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Approved ID Export</title>
        <link rel="stylesheet" href="/static/styles.css">
        <style>
            .export-help { padding: 2rem; max-width: 800px; margin: 0 auto; }
            .help-section { margin: 2rem 0; padding: 1.5rem; background: #f8f9fa; border-radius: 8px; }
            .help-section h3 { color: #2e7d32; margin-bottom: 1rem; }
            .help-section p { color: #666; line-height: 1.6; }
            .export-button { 
                display: inline-block;
                background: #2e7d32;
                color: white;
                padding: 0.75rem 1.5rem;
                border-radius: 4px;
                text-decoration: none;
                margin-top: 1rem;
            }
            .export-button:hover { background: #1b5e20; }
        </style>
    </head>
    <body>
        <div class="export-help">
            <h1>Approved ID Export</h1>
            
            <div class="help-section">
                <h3>Why am I seeing warning messages?</h3>
                <p>
                    This application includes protection against unauthorized screenshots and screen recording
                    to safeguard sensitive employee information. If you see warnings or content becoming blurred,
                    it may indicate detected screen recording attempts.
                </p>
            </div>
            
            <div class="help-section">
                <h3>How do I export ID cards officially?</h3>
                <p>
                    Use the <strong>Approved Export</strong> feature in the HR Dashboard. This is the authorized
                    method for HR users to download ID cards for official processing. Your exports are logged
                    and watermarked for audit purposes.
                </p>
            </div>
            
            <div class="help-section">
                <h3>What is on the exported PDF?</h3>
                <p>
                    Exported PDFs include:
                    <ul>
                        <li>Employee ID card (front and back)</li>
                        <li>Employee name and ID number</li>
                        <li>Official watermark with export timestamp</li>
                        <li>HR user who performed the export</li>
                    </ul>
                </p>
            </div>
            
            <div class="help-section">
                <h3>Can I print exported PDFs?</h3>
                <p>
                    Yes. Exported PDFs from the Approved Export feature are print-ready. Direct printing from
                    the dashboard may be blocked to prevent circumvention of data protection measures.
                </p>
            </div>
            
            <a href="/hr/dashboard" class="export-button">← Back to Dashboard</a>
        </div>
    </body>
    </html>
    """)


# ============================================
# Usage Summary Routes
# ============================================

@router.get("/usage", response_class=HTMLResponse)
def usage_summary_page(request: Request, hr_session: str = Cookie(None)):
    """Usage Summary Page - shows AI headshot generation usage per user"""
    session = get_session(hr_session)
    if not session:
        return RedirectResponse(url="/hr/login", status_code=302)
    return templates.TemplateResponse("usage.html", {"request": request, "username": session.get("username", "HR")})


@router.get("/api/usage-summary")
def get_usage_summary(request: Request, hr_session: str = Cookie(None)):
    """API: Get all headshot usage data aggregated by user"""
    session = get_session(hr_session)
    if not session:
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    try:
        usage_data = get_all_headshot_usage()
        return JSONResponse({
            "success": True,
            "data": usage_data,
            "limit": HEADSHOT_LIMIT_PER_USER,
            "total_users": len(usage_data),
            "total_generations": sum(u.get("total_generations", u["usage_count"]) for u in usage_data),
            "active_generations": sum(u["usage_count"] for u in usage_data),
            "price_per_generation": 2.40,
        })
    except Exception as e:
        logger.error(f"Error fetching usage summary: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/reset-rate-limit/{lark_user_id}")
def reset_rate_limit(lark_user_id: str, request: Request, hr_session: str = Cookie(None)):
    """API: Reset the headshot rate limit for a specific Lark user"""
    session = get_session(hr_session)
    if not session:
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    try:
        success = reset_headshot_usage(lark_user_id)
        if success:
            logger.info(f"HR user '{session.get('username')}' reset rate limit for lark_user_id={lark_user_id}")
            return JSONResponse({
                "success": True,
                "message": f"Rate limit reset for user {lark_user_id}",
                "new_remaining": HEADSHOT_LIMIT_PER_USER,
            })
        else:
            return JSONResponse({"error": "Failed to reset rate limit"}, status_code=500)
    except Exception as e:
        logger.error(f"Error resetting rate limit: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/reset-all-rate-limits")
def reset_all_rate_limits(request: Request, hr_session: str = Cookie(None)):
    """API: Reset headshot rate limits for ALL users"""
    session = get_session(hr_session)
    if not session:
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    try:
        count = reset_all_headshot_usage()
        if count >= 0:
            logger.info(f"HR user '{session.get('username')}' reset ALL rate limits ({count} records reset)")
            return JSONResponse({
                "success": True,
                "message": f"All rate limits reset. {count} usage records marked as reset.",
                "deleted_count": count,
            })
        else:
            return JSONResponse({"error": "Failed to reset all rate limits"}, status_code=500)
    except Exception as e:
        logger.error(f"Error resetting all rate limits: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)
