"""
Employee Routes - From Code 1
Handles employee registration, AI headshot generation, and form submission.
Protected by Lark authentication.
Uses TransactionManager for ACID compliance across multi-step API workflows.
"""
from fastapi import APIRouter, Request, UploadFile, File, Form, HTTPException, Body, Cookie
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
import shutil
import os
import logging
import traceback
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional
from pydantic import BaseModel

# Database abstraction layer (supports Supabase and SQLite)
from app.database import insert_employee, delete_employee, USE_SUPABASE, get_headshot_usage_count, increment_headshot_usage, check_headshot_limit

# Lark Bitable integration (for appending data)
from app.services.lark_service import (
    append_employee_submission, 
    append_spma_employee_submission,
    LARK_TABLE_ID_SPMA
)
# Cloudinary integration (for image uploads)
from app.services.cloudinary_service import (
    upload_image_to_cloudinary, 
    upload_base64_to_cloudinary,
    upload_url_with_bg_removal,
    upload_url_to_cloudinary_simple,
    delete_from_cloudinary,
)
# BytePlus Seedream integration (for AI headshot generation)
from app.services.seedream_service import generate_headshot_from_url

# Authentication
from app.auth import get_session

# ACID Transaction Manager & Cache
from app.transaction_manager import TransactionManager, TransactionError
from app.workflow_cache import WorkflowCache, make_cache_key, TTL_EXTENDED, TTL_DEFAULT

router = APIRouter()

# Get the directory where this file is located
BASE_DIR = Path(__file__).resolve().parent.parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# Configure logging
logger = logging.getLogger(__name__)

# Check if running on Vercel (serverless) or locally
IS_VERCEL = os.environ.get("VERCEL", False)


def verify_employee_auth(employee_session: str) -> bool:
    """Verify employee is authenticated via Lark"""
    if not employee_session:
        return False
    session = get_session(employee_session)
    if not session:
        return False
    return session.get("auth_type") == "lark"


# Request model for generate-headshot endpoint
class GenerateHeadshotRequest(BaseModel):
    image: str  # Base64-encoded image
    prompt_type: str = "male_1"  # One of: male_1-4, female_1-4 (smart casual attire)


@router.get("/headshot-usage")
async def api_headshot_usage(employee_session: str = Cookie(None)):
    """Return the current Lark user's AI headshot generation usage and remaining count."""
    if not verify_employee_auth(employee_session):
        return JSONResponse(status_code=401, content={"success": False, "error": "Authentication required."})

    session = get_session(employee_session)
    lark_user_id = session.get("lark_user_id", "") if session else ""
    if not lark_user_id:
        return JSONResponse(status_code=200, content={"success": True, "used": 0, "limit": 5, "remaining": 5})

    info = check_headshot_limit(lark_user_id)
    return JSONResponse(status_code=200, content={"success": True, **info})


@router.post("/generate-headshot")
async def api_generate_headshot(request: GenerateHeadshotRequest, employee_session: str = Cookie(None)):
    """
    Generate a professional headshot using BytePlus Seedream API with transparent background.
    Requires Lark authentication.
    
    Complete Flow:
        1. Upload base64 image to Cloudinary (to get a public URL)
        2. Send URL to BytePlus Seedream API with selected prompt
        3. Upload AI image to Cloudinary with background removal
        4. Return final Cloudinary URL (transparent image)
    
    Expects JSON body with:
        image: Base64-encoded image data (with or without data URI prefix)
        prompt_type: One of 'male_1' through 'male_4' or 'female_1' through 'female_4' (default: male_1)
    
    Returns:
        JSON with generated_image (Cloudinary URL of transparent PNG) on success
        JSON with error message on failure
    """
    # Verify employee authentication
    if not verify_employee_auth(employee_session):
        logger.warning("Unauthorized headshot generation attempt - no valid session")
        return JSONResponse(
            status_code=401,
            content={"success": False, "error": "Authentication required. Please log in again."}
        )
    
    # --- Rate Limiting: 5 AI headshots per Lark user ---
    session = get_session(employee_session)
    lark_user_id = session.get("lark_user_id", "") if session else ""
    lark_name = session.get("lark_name", "") if session else ""
    if lark_user_id:
        limit_info = check_headshot_limit(lark_user_id)
        if not limit_info["allowed"]:
            logger.warning(f"Headshot rate limit reached for Lark user {lark_user_id} ({limit_info['used']}/{limit_info['limit']})")
            return JSONResponse(
                status_code=429,
                content={
                    "success": False,
                    "error": "AI headshot generation limit reached. Please contact HR to request a reset.",
                    "rate_limited": True,
                    "used": limit_info["used"],
                    "limit": limit_info["limit"],
                    "remaining": 0,
                }
            )
    
    try:
        logger.info(f"Received headshot generation request with prompt_type: {request.prompt_type}")
        
        if not request.image:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "No image data provided"}
            )
        
        # Validate prompt_type (8 smart casual attire options)
        valid_prompt_types = ["male_1", "male_2", "male_3", "male_4", "female_1", "female_2", "female_3", "female_4"]
        prompt_type = request.prompt_type if request.prompt_type in valid_prompt_types else "male_1"
        
        # ====================================================================
        # ACID TRANSACTION: AI Headshot Generation
        # Steps: Upload original → Seedream AI → Cloudinary bg removal
        # If any step fails, all completed Cloudinary uploads are rolled back.
        # Cache keys ensure re-attempts reuse previous successful results.
        # ====================================================================
        txn = TransactionManager("generate_headshot", context={
            "lark_user_id": lark_user_id,
            "prompt_type": prompt_type,
        })
        
        try:
            # Step 1: Upload original to Cloudinary to get a public URL
            temp_id = f"temp_preview_{uuid.uuid4().hex[:8]}"
            
            cloudinary_url = txn.execute_step(
                name="upload_original_to_cloudinary",
                action=lambda: upload_base64_to_cloudinary(
                    base64_data=request.image,
                    public_id=temp_id,
                    folder="seedream_temp"
                ),
                rollback=lambda url: delete_from_cloudinary(url),
                error_message="Failed to process image. Please try again.",
            )
            
            # Step 2: Generate headshot using Seedream
            # Cache key based on Cloudinary URL + prompt type for reuse
            seedream_cache_key = make_cache_key("seedream", cloudinary_url, prompt_type)
            
            def _generate_seedream():
                gen_url, err = generate_headshot_from_url(cloudinary_url, prompt_type)
                if not gen_url:
                    raise Exception(err or "Failed to generate headshot")
                return gen_url
            
            generated_url = txn.execute_step(
                name="generate_seedream_headshot",
                action=_generate_seedream,
                cache_key=seedream_cache_key,
                is_critical=False,
                error_message="Failed to generate headshot. Please try again.",
            )

            # If Seedream fails (e.g., image parameter format rejected), fall back
            # to the uploaded/local source image so the workflow still succeeds.
            if not generated_url:
                logger.warning("Seedream generation unavailable. Falling back to source image.")
                generated_url = cloudinary_url
            
            # Increment headshot usage count after successful AI generation
            if lark_user_id:
                increment_headshot_usage(lark_user_id, lark_name)
                new_limit_info = check_headshot_limit(lark_user_id)
                logger.info(f"Headshot usage incremented for {lark_user_id}: {new_limit_info['used']}/{new_limit_info['limit']}")
            else:
                new_limit_info = {"used": 0, "limit": 5, "remaining": 5}
            
            # Step 3: Upload AI image to Cloudinary with background removal
            final_id = f"headshot_transparent_{uuid.uuid4().hex[:8]}"
            
            def _upload_with_bg_removal():
                url, is_transparent = upload_url_with_bg_removal(
                    image_url=generated_url,
                    public_id=final_id,
                    folder="headshots"
                )
                if url:
                    return {"url": url, "transparent": is_transparent}
                # Fallback: upload without background removal
                logger.warning("Cloudinary bg removal failed, uploading without processing")
                fallback_url = upload_url_to_cloudinary_simple(
                    image_url=generated_url,
                    public_id=final_id,
                    folder="headshots"
                )
                if fallback_url:
                    return {"url": fallback_url, "transparent": False}
                # Last resort: use original Seedream URL
                return {"url": generated_url, "transparent": False}
            
            final_result = txn.execute_step(
                name="upload_final_headshot",
                action=_upload_with_bg_removal,
                rollback=lambda r: delete_from_cloudinary(r["url"]) if r and r["url"] != generated_url else None,
                is_critical=False,  # Even if bg removal fails, we still have the Seedream URL
            )
            
            # Commit the transaction
            summary = txn.commit()
            
            # Determine final URL and transparency
            if final_result:
                final_url = final_result["url"]
                is_transparent = final_result["transparent"]
            else:
                final_url = generated_url
                is_transparent = False
            
            return JSONResponse(
                status_code=200,
                content={
                    "success": True,
                    "generated_image": final_url,
                    "transparent": is_transparent,
                    "message": (
                        "AI headshot generated"
                        if final_url != cloudinary_url
                        else "AI generation unavailable. Using source image."
                    ) + (" with transparent background" if is_transparent else " (background removal unavailable)"),
                    "used": new_limit_info["used"],
                    "limit": new_limit_info["limit"],
                    "remaining": new_limit_info["remaining"],
                    "transaction": summary,
                }
            )
            
        except TransactionError as te:
            # Rollback all completed steps
            txn.rollback()
            logger.error(f"Headshot generation transaction failed: {te}")
            return JSONResponse(
                status_code=500,
                content={
                    "success": False,
                    "error": str(te),
                    "transaction": txn.get_summary(),
                }
            )
            
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Error in generate-headshot endpoint: {error_msg}\n{traceback.format_exc()}")
        # Provide more user-friendly error messages
        if "API key" in error_msg.lower() or "unauthorized" in error_msg.lower():
            user_error = "AI service configuration error. Please contact support."
        elif "timeout" in error_msg.lower():
            user_error = "AI service is taking too long. Please try again."
        elif "connection" in error_msg.lower():
            user_error = "Unable to connect to AI service. Please try again."
        else:
            user_error = f"Failed to generate headshot: {error_msg}"
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": user_error}
        )


# Request model for remove-background endpoint
class RemoveBackgroundRequest(BaseModel):
    image: str  # URL or base64-encoded image
    is_url: bool = True  # True if image is a URL, False if base64


@router.post("/remove-background")
async def api_remove_background(request: RemoveBackgroundRequest, employee_session: str = Cookie(None)):
    """
    Remove background from an image using Cloudinary AI.
    Requires Lark authentication.
    
    Expects JSON body with:
        image: URL or base64-encoded image
        is_url: True if image is a URL, False if base64 (default: True)
    
    Returns:
        JSON with processed_image (Cloudinary URL with transparency) on success
        JSON with error message on failure
    """
    # Verify employee authentication
    if not verify_employee_auth(employee_session):
        logger.warning("Unauthorized background removal attempt - no valid session")
        return JSONResponse(
            status_code=401,
            content={"success": False, "error": "Authentication required. Please log in again."}
        )
    
    try:
        logger.info(f"Received background removal request (is_url: {request.is_url})")
        
        if not request.image:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "No image data provided"}
            )
        
        # Generate unique ID for the processed image
        processed_id = f"bg_removed_{uuid.uuid4().hex[:8]}"
        
        if request.is_url:
            # Upload URL with background removal
            result_url, is_transparent = upload_url_with_bg_removal(
                image_url=request.image,
                public_id=processed_id,
                folder="processed"
            )
        else:
            # First upload the base64 image, then apply bg removal
            temp_url = upload_base64_to_cloudinary(
                base64_data=request.image,
                public_id=f"temp_{processed_id}",
                folder="temp"
            )
            if temp_url:
                result_url, is_transparent = upload_url_with_bg_removal(
                    image_url=temp_url,
                    public_id=processed_id,
                    folder="processed"
                )
            else:
                result_url, is_transparent = None, False
        
        if result_url:
            logger.info(f"Background removed successfully (transparent: {is_transparent})")
            return JSONResponse(
                status_code=200,
                content={
                    "success": True,
                    "processed_image": result_url,  # Cloudinary URL
                    "transparent": is_transparent,
                    "available": True
                }
            )
        else:
            logger.warning("Failed to remove background via Cloudinary")
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": "Failed to remove background"}
            )
            
    except Exception as e:
        logger.error(f"Error in remove-background endpoint: {str(e)}\n{traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.get("/background-removal-status")
async def background_removal_status():
    """Check if background removal service is available."""
    # Cloudinary AI background removal is always available if Cloudinary is configured
    return JSONResponse(
        status_code=200,
        content={
            "available": True,
            "message": "Background removal is available via Cloudinary AI"
        }
    )


@router.post("/submit")
async def submit_employee(
    first_name: str = Form(...),
    middle_initial: str = Form(''),
    last_name: str = Form(...),
    suffix: str = Form(''),
    suffix_custom: str = Form(''),
    id_nickname: str = Form(''),
    id_number: str = Form(...),
    position: str = Form(...),
    location_branch: Optional[str] = Form(''),
    email: str = Form(...),
    personal_number: str = Form(...),
    photo: UploadFile = File(...),
    signature_data: str = Form(...),
    ai_headshot_data: Optional[str] = Form(None),  # AI-generated headshot URL from frontend
    ai_generated_image: Optional[str] = Form(None),  # Alternative field name for AI headshot URL
    emergency_name: Optional[str] = Form(''),  # Emergency contact name
    emergency_contact: Optional[str] = Form(''),  # Emergency contact number
    emergency_address: Optional[str] = Form(''),  # Emergency contact address
    form_type: Optional[str] = Form('SPMC'),  # Form type: SPMC or SPMA
    # Field Officer specific fields
    field_officer_type: Optional[str] = Form(''),  # Repossessor, Shared, or Others
    field_clearance: Optional[str] = Form(''),  # Level 5
    fo_division: Optional[str] = Form(''),  # Division dropdown
    fo_department: Optional[str] = Form(''),  # Department dropdown
    fo_campaign: Optional[str] = Form(''),  # Campaign dropdown
    employee_session: str = Cookie(None)  # Lark authentication
):
    """Submit employee registration - requires Lark authentication, returns JSON response."""
    import base64
    
    # Verify Lark authentication
    if not verify_employee_auth(employee_session):
        return JSONResponse(
            status_code=401,
            content={"success": False, "error": "Authentication required. Please sign in with Lark."}
        )
    
    # ========================================
    # QA-GRADE BACKEND VALIDATION
    # ========================================
    from app.validators import (
        validate_employee_form,
        validate_id_number,
    )
    from app.database import get_employee_by_id_number
    
    # Build validation data dictionary
    validation_data = {
        'first_name': first_name,
        'middle_initial': middle_initial,
        'last_name': last_name,
        'suffix': suffix,
        'suffix_custom': suffix_custom,
        'id_number': id_number,
        'position': position,
        'field_officer_type': field_officer_type,
        'location_branch': location_branch,
        'email': email,
        'personal_number': personal_number,
        'emergency_name': emergency_name,
        'emergency_contact': emergency_contact,
        'emergency_address': emergency_address,
    }
    
    # Run comprehensive validation
    is_valid, errors, cleaned_data = validate_employee_form(validation_data)
    
    if not is_valid:
        # Return all validation errors
        logger.warning(f"Form validation failed: {errors}")
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "Validation failed",
                "validation_errors": errors,
                "detail": "; ".join([f"{field}: {msg}" for field, msg in errors.items()])
            }
        )
    
    # Check ID number uniqueness
    existing_employee = get_employee_by_id_number(cleaned_data['id_number'])
    if existing_employee:
        logger.warning(f"Duplicate ID number: {cleaned_data['id_number']}")
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "Duplicate ID number",
                "validation_errors": {"id_number": f"ID Number '{cleaned_data['id_number']}' is already registered"},
                "detail": f"ID Number '{cleaned_data['id_number']}' is already registered in the system"
            }
        )
    
    # Use cleaned/validated data
    first_name = cleaned_data['first_name']
    middle_initial = cleaned_data['middle_initial']
    last_name = cleaned_data['last_name']
    final_suffix = cleaned_data['suffix']
    id_number = cleaned_data['id_number']
    email = cleaned_data['email']
    personal_number = cleaned_data['personal_number']
    emergency_name = cleaned_data.get('emergency_name', '')
    emergency_contact = cleaned_data.get('emergency_contact', '')
    emergency_address = cleaned_data.get('emergency_address', '')
    
    logger.info(f"Backend validation passed for ID: {id_number}")
    # ========================================
    # END BACKEND VALIDATION
    # ========================================
    
    # Construct full employee_name from parts for backward compatibility
    employee_name_parts = [first_name]
    if middle_initial:
        mi = middle_initial
        if not mi.endswith('.'):
            mi += '.'
        employee_name_parts.append(mi)
    if last_name:
        employee_name_parts.append(last_name)
    
    # Add validated suffix
    if final_suffix:
        employee_name_parts.append(final_suffix)
    
    employee_name = ' '.join(employee_name_parts)
    
    # ====================================================================
    # ACID TRANSACTION: Employee Registration
    # Steps: Save files → Upload Cloudinary → Insert DB → Append Lark
    # On failure, all completed steps are rolled back automatically.
    # ====================================================================
    txn = TransactionManager("employee_submit", context={"id_number": id_number})
    
    try:
        # Ensure uploads directory exists
        # Use /tmp on Vercel (only writable directory in serverless)
        if IS_VERCEL:
            uploads_dir = "/tmp/uploads"
        else:
            uploads_dir = str(BASE_DIR / "static" / "uploads")
        os.makedirs(uploads_dir, exist_ok=True)
        
        # Save photo with timestamp
        timestamp = datetime.now().timestamp()
        filename = f"{timestamp}_{photo.filename}"
        photo_path = os.path.join(uploads_dir, filename)
        
        with open(photo_path, "wb") as buffer:
            shutil.copyfileobj(photo.file, buffer)
        
        # Store relative path for serving (without app/static prefix)
        photo_local_path = f"uploads/{filename}"
        
        # Save signature from base64
        signature_local_path = None
        if signature_data and signature_data.startswith('data:image'):
            try:
                # Extract base64 data (remove "data:image/png;base64," prefix)
                header, encoded = signature_data.split(',', 1)
                signature_bytes = base64.b64decode(encoded)
                signature_filename = f"{timestamp}_signature.png"
                signature_path = os.path.join(uploads_dir, signature_filename)
                
                with open(signature_path, "wb") as sig_file:
                    sig_file.write(signature_bytes)
                
                signature_local_path = f"uploads/{signature_filename}"
                logger.info(f"Saved signature for employee: {id_number}")
            except Exception as e:
                logger.error(f"Error saving signature: {str(e)}")

        # ===== CLOUDINARY + SHEETS INTEGRATION (TRANSACTIONAL) =====
        date_last_modified = datetime.now().isoformat()
        
        # Create deterministic public IDs using employee ID number
        # Sanitize id_number for use as public_id (remove special chars)
        safe_id = id_number.replace(' ', '_').replace('/', '-').replace('\\', '-')
        
        # Step 1: Upload photo to Cloudinary (with cache + rollback)
        photo_cache_key = make_cache_key("photo", safe_id)
        cloudinary_photo_url = txn.execute_step(
            name="upload_photo_cloudinary",
            action=lambda: upload_image_to_cloudinary(
                file_path=photo_path,
                public_id=f"{safe_id}_photo"
            ),
            rollback=lambda url: delete_from_cloudinary(url),
            cache_key=photo_cache_key,
            is_critical=False,  # Submission can proceed without Cloudinary
            error_message=f"Failed to upload photo to cloud for {id_number}",
        )
        
        # Step 2: Upload signature to Cloudinary (with cache + rollback)
        cloudinary_signature_url = None
        if signature_local_path:
            sig_cache_key = make_cache_key("signature", safe_id)
            signature_path_full = os.path.join(uploads_dir, os.path.basename(signature_local_path.replace('uploads/', '')))
            
            cloudinary_signature_url = txn.execute_step(
                name="upload_signature_cloudinary",
                action=lambda: upload_image_to_cloudinary(
                    file_path=signature_path_full,
                    public_id=f"{safe_id}_signature"
                ),
                rollback=lambda url: delete_from_cloudinary(url),
                cache_key=sig_cache_key,
                is_critical=False,  # Submission can proceed without signature upload
                error_message=f"Failed to upload signature to cloud for {id_number}",
            )

        # Step 3: Handle AI-generated headshot URL (with cache)
        cloudinary_ai_headshot_url = None
        effective_ai_data = ai_headshot_data or ai_generated_image
        if effective_ai_data:
            if effective_ai_data.startswith('http'):
                # Direct URL from Seedream - use as-is (already in Cloudinary)
                cloudinary_ai_headshot_url = effective_ai_data
                logger.info(f"Using Seedream URL directly for AI headshot: {cloudinary_ai_headshot_url[:80]}...")
            elif effective_ai_data.startswith('data:image'):
                # Legacy base64 format - upload to Cloudinary
                ai_cache_key = make_cache_key("ai_headshot", safe_id)
                cloudinary_ai_headshot_url = txn.execute_step(
                    name="upload_ai_headshot_cloudinary",
                    action=lambda: upload_base64_to_cloudinary(
                        base64_data=effective_ai_data,
                        public_id=f"{safe_id}_ai_headshot",
                        folder="employees"
                    ),
                    rollback=lambda url: delete_from_cloudinary(url),
                    cache_key=ai_cache_key,
                    is_critical=False,
                    error_message=f"Failed to upload AI headshot for {id_number}",
                )

        # Step 4: Save to database (CRITICAL - rollback = delete record)
        employee_data = {
            'employee_name': employee_name,
            'first_name': first_name,
            'middle_initial': middle_initial,
            'last_name': last_name,
            'suffix': final_suffix,
            'id_nickname': id_nickname.strip().capitalize() if id_nickname else '',
            'id_number': id_number,
            'position': position,
            'location_branch': location_branch,
            'department': fo_department or '',
            'email': email,
            'personal_number': personal_number,
            'photo_path': photo_local_path,
            'photo_url': cloudinary_photo_url or '',
            'new_photo': 1,
            'new_photo_url': cloudinary_ai_headshot_url or '',
            'signature_path': signature_local_path or '',
            'signature_url': cloudinary_signature_url or '',
            'status': 'Reviewing',
            'date_last_modified': date_last_modified,
            'id_generated': 0,
            'render_url': '',
            'emergency_name': emergency_name or '',
            'emergency_contact': emergency_contact or '',
            'emergency_address': emergency_address or '',
            'field_officer_type': field_officer_type or '',
            'field_clearance': field_clearance or '',
            'fo_division': fo_division or '',
            'fo_department': fo_department or '',
            'fo_campaign': fo_campaign or ''
        }
        
        logger.info("=" * 60)
        logger.info("📋 EMPLOYEE DATA PAYLOAD FOR DATABASE INSERT:")
        logger.info(f"  ID Number: {id_number}")
        logger.info(f"  Position: {position}")
        logger.info(f"  field_officer_type: {field_officer_type or 'NOT SET'}")
        logger.info("=" * 60)
        
        employee_id = txn.execute_step(
            name="insert_database",
            action=lambda: insert_employee(employee_data),
            rollback=lambda eid: delete_employee(eid) if eid else None,
            error_message="Failed to save employee to database",
        )
        
        logger.info(f"Employee saved to database (id={employee_id}, supabase={USE_SUPABASE})")
        
        # Step 5: Append submission to Lark Bitable (non-critical)
        target_lark_table = LARK_TABLE_ID_SPMA if form_type == 'SPMA' else None
        logger.info(f"📋 Form Type: {form_type} → Table: {target_lark_table or 'default (SPMC)'}")
        
        lark_success = txn.execute_step(
            name="append_lark_bitable",
            action=lambda: append_employee_submission(
                employee_name=employee_name,
                id_nickname=id_nickname.strip().capitalize() if id_nickname else '',
                id_number=id_number,
                position=position,
                location_branch=location_branch,
                department=fo_department or '',
                email=email,
                personal_number=personal_number,
                photo_path=photo_local_path,
                signature_path=signature_local_path,
                status='Reviewing',
                date_last_modified=date_last_modified,
                photo_url=cloudinary_photo_url,
                signature_url=cloudinary_signature_url,
                ai_headshot_url=cloudinary_ai_headshot_url,
                render_url='',
                first_name=first_name,
                middle_initial=middle_initial,
                last_name=last_name,
                suffix=final_suffix,
                table_id=target_lark_table,
                field_officer_type=field_officer_type or '',
                field_clearance=field_clearance or '',
                fo_division=fo_division or '',
                fo_campaign=fo_campaign or ''
            ),
            is_critical=False,  # Don't fail submission if Lark sync fails
            error_message=f"Failed to sync to Lark Bitable for {id_number}",
        )
        
        if lark_success:
            logger.info(f"✅ Successfully appended employee submission to Lark Bitable: {id_number}")
        else:
            logger.warning(f"⚠️ Failed to append to Lark Bitable (submission still saved to database): {id_number}")
        
        # ===== END CLOUDINARY + LARK INTEGRATION =====
        
        # Commit the transaction
        summary = txn.commit()

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "message": "Submission successful",
                "transaction": summary,
            }
        )
        
    except TransactionError as te:
        # ACID Rollback: undo all completed steps in reverse order
        txn.rollback()
        logger.error(f"Employee submission transaction failed: {te}")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": "Submission failed",
                "detail": str(te),
                "transaction": txn.get_summary(),
            }
        )
        
    except Exception as e:
        # Catch-all: rollback if transaction is still active
        if txn.status.value == "active":
            txn.rollback()
        logger.error(f"Submit error: {str(e)}\n{traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": "Submission failed",
                "detail": str(e),
                "transaction": txn.get_summary(),
            }
        )


@router.post("/submit-spma")
async def submit_spma_employee(
    first_name: str = Form(...),
    middle_initial: str = Form(''),
    last_name: str = Form(...),
    suffix: str = Form(''),
    suffix_custom: str = Form(''),
    id_number: str = Form(...),
    division: str = Form(...),
    department: str = Form(...),
    field_clearance: str = Form(...),
    location_branch: Optional[str] = Form(''),
    email: str = Form(...),
    personal_number: str = Form(...),
    photo: UploadFile = File(...),
    signature_data: str = Form(...),
    employee_session: str = Cookie(None)
):
    """Submit SPMA (Legal Officer) employee registration - dedicated endpoint for SPMA form."""
    import base64
    
    # Verify Lark authentication
    if not verify_employee_auth(employee_session):
        return JSONResponse(
            status_code=401,
            content={"success": False, "error": "Authentication required. Please sign in with Lark."}
        )
    
    # Construct full employee_name from parts
    employee_name_parts = [first_name]
    if middle_initial:
        mi = middle_initial.strip()
        if not mi.endswith('.'):
            mi += '.'
        employee_name_parts.append(mi)
    if last_name:
        employee_name_parts.append(last_name)
    
    # Add suffix (use custom suffix if "Other" was selected)
    final_suffix = suffix_custom.strip() if suffix == 'Other' and suffix_custom else suffix.strip()
    if final_suffix:
        employee_name_parts.append(final_suffix)
    
    employee_name = ' '.join(employee_name_parts)
    
    logger.info(f"📋 SPMA Form Submission: {employee_name} (ID: {id_number})")
    logger.info(f"   Division: {division}, Department: {department}")
    logger.info(f"   Field Clearance: {field_clearance}")
    
    try:
        # Ensure uploads directory exists
        if IS_VERCEL:
            uploads_dir = "/tmp/uploads"
        else:
            uploads_dir = str(BASE_DIR / "static" / "uploads")
        os.makedirs(uploads_dir, exist_ok=True)
        
        # Save photo with timestamp
        timestamp = datetime.now().timestamp()
        filename = f"{timestamp}_{photo.filename}"
        photo_path = os.path.join(uploads_dir, filename)
        
        with open(photo_path, "wb") as buffer:
            shutil.copyfileobj(photo.file, buffer)
        
        photo_local_path = f"uploads/{filename}"
        
        # Save signature from base64
        signature_local_path = None
        if signature_data and signature_data.startswith('data:image'):
            try:
                header, encoded = signature_data.split(',', 1)
                signature_bytes = base64.b64decode(encoded)
                signature_filename = f"{timestamp}_signature.png"
                signature_path = os.path.join(uploads_dir, signature_filename)
                
                with open(signature_path, "wb") as sig_file:
                    sig_file.write(signature_bytes)
                
                signature_local_path = f"uploads/{signature_filename}"
                logger.info(f"Saved SPMA signature for employee: {id_number}")
            except Exception as e:
                logger.error(f"Error saving SPMA signature: {str(e)}")

        # ====================================================================
        # ACID TRANSACTION: SPMA Employee Registration
        # Steps: Upload Photo → Upload Signature → Insert DB → Append Lark
        # If DB insert fails, Cloudinary uploads are rolled back.
        # ====================================================================
        date_last_modified = datetime.now().isoformat()
        safe_id = id_number.replace(' ', '_').replace('/', '-').replace('\\', '-')
        
        txn = TransactionManager("spma_submit", context={
            "id_number": id_number,
            "employee_name": employee_name,
        })
        
        try:
            # Step 1: Upload photo to Cloudinary (non-critical - local fallback)
            photo_cache_key = make_cache_key("spma_photo", safe_id)
            cloudinary_photo_url = None
            try:
                cloudinary_photo_url = txn.execute_step(
                    name="upload_photo_cloudinary",
                    action=lambda: upload_image_to_cloudinary(
                        file_path=photo_path,
                        public_id=f"spma_{safe_id}_photo"
                    ),
                    rollback=lambda url: delete_from_cloudinary(url),
                    cache_key=photo_cache_key,
                    is_critical=False,
                )
                if cloudinary_photo_url:
                    logger.info(f"✅ SPMA photo uploaded: {cloudinary_photo_url[:60]}...")
            except Exception as e:
                logger.error(f"Error uploading SPMA photo: {str(e)}")
            
            # Step 2: Upload signature to Cloudinary (non-critical)
            cloudinary_signature_url = None
            if signature_local_path:
                sig_cache_key = make_cache_key("spma_signature", safe_id)
                try:
                    signature_path_full = os.path.join(uploads_dir, os.path.basename(signature_local_path.replace('uploads/', '')))
                    cloudinary_signature_url = txn.execute_step(
                        name="upload_signature_cloudinary",
                        action=lambda: upload_image_to_cloudinary(
                            file_path=signature_path_full,
                            public_id=f"spma_{safe_id}_signature"
                        ),
                        rollback=lambda url: delete_from_cloudinary(url),
                        cache_key=sig_cache_key,
                        is_critical=False,
                    )
                    if cloudinary_signature_url:
                        logger.info(f"✅ SPMA signature uploaded: {cloudinary_signature_url[:60]}...")
                except Exception as e:
                    logger.error(f"Error uploading SPMA signature: {str(e)}")

            # Step 3: Save to database (CRITICAL)
            employee_data = {
                'employee_name': employee_name,
                'first_name': first_name,
                'middle_initial': middle_initial,
                'last_name': last_name,
                'suffix': final_suffix,
                'id_nickname': '',
                'id_number': id_number,
                'position': 'Legal Officer',
                'location_branch': location_branch,
                'department': department,
                'email': email,
                'personal_number': personal_number,
                'photo_path': photo_local_path,
                'photo_url': cloudinary_photo_url or '',
                'new_photo': 0,
                'new_photo_url': '',
                'signature_path': signature_local_path or '',
                'signature_url': cloudinary_signature_url or '',
                'status': 'Reviewing',
                'date_last_modified': date_last_modified,
                'id_generated': 0,
                'render_url': '',
                'emergency_name': '',
                'emergency_contact': '',
                'emergency_address': ''
            }
            
            employee_id = txn.execute_step(
                name="insert_database",
                action=lambda: insert_employee(employee_data),
                rollback=lambda eid: delete_employee(eid) if eid else None,
                error_message="Failed to save SPMA employee to database",
            )
            
            if employee_id is None:
                raise TransactionError(
                    "Database insert returned None",
                    transaction_id=txn.transaction_id,
                    step_name="insert_database",
                )
            
            logger.info(f"✅ SPMA employee saved to database (id={employee_id})")
            
            # Step 4: Append to SPMA Lark Table (non-critical)
            try:
                txn.execute_step(
                    name="append_lark_bitable",
                    action=lambda: append_spma_employee_submission(
                        employee_name=employee_name,
                        middle_initial=middle_initial,
                        last_name=last_name,
                        suffix=final_suffix,
                        id_number=id_number,
                        division=division,
                        department=department,
                        field_clearance=field_clearance,
                        branch_location=location_branch,
                        email=email,
                        personal_number=personal_number,
                        photo_url=cloudinary_photo_url,
                        signature_url=cloudinary_signature_url
                    ),
                    is_critical=False,
                )
            except Exception as e:
                logger.error(f"❌ Error appending SPMA to Lark: {str(e)}")
            
            summary = txn.commit()
            
            return JSONResponse(
                status_code=200,
                content={
                    "success": True,
                    "message": "SPMA submission successful",
                    "transaction": summary,
                }
            )
            
        except TransactionError as te:
            txn.rollback()
            logger.error(f"SPMA submission transaction failed: {te}")
            return JSONResponse(
                status_code=500,
                content={
                    "success": False,
                    "error": "Submission failed",
                    "detail": str(te),
                    "transaction": txn.get_summary(),
                }
            )
        
    except Exception as e:
        logger.error(f"SPMA Submit error: {str(e)}\n{traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Submission failed", "detail": str(e)}
        )
