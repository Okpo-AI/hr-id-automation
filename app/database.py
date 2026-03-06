"""
Database Configuration - Supabase PostgreSQL
Persistent database for Vercel deployment using Supabase.

Environment Variables Required:
- SUPABASE_URL: Your Supabase project URL
- SUPABASE_KEY: Your Supabase anon/service key

For local development without Supabase, falls back to SQLite.
"""
import os
import logging
from typing import Optional, List, Dict, Any
from datetime import datetime

logger = logging.getLogger(__name__)

# Supabase is opt-in. Default runtime is SQLite unless ENABLE_SUPABASE=true.
ENABLE_SUPABASE = os.environ.get("ENABLE_SUPABASE", "false").lower() in ("1", "true", "yes", "on")

# Check if Supabase credentials are available
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
USE_SUPABASE = ENABLE_SUPABASE and bool(SUPABASE_URL and SUPABASE_KEY)

# Fallback to SQLite for local development
IS_VERCEL = os.environ.get("VERCEL", "0") == "1" or os.environ.get("VERCEL_ENV") is not None
SQLITE_DB = "/tmp/database.db" if IS_VERCEL else "database.db"

logger.info(f"Database config: USE_SUPABASE={USE_SUPABASE}, IS_VERCEL={IS_VERCEL}")

# Initialize Supabase client if available
supabase_client = None
if USE_SUPABASE:
    try:
        from supabase import create_client, Client
        supabase_client: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
        logger.info("Supabase client initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize Supabase client: {e}")
        USE_SUPABASE = False


# =============================================================================
# SQLite Fallback (for local development)
# =============================================================================
def get_sqlite_connection():
    """Get SQLite connection for local development"""
    import sqlite3
    conn = sqlite3.connect(SQLITE_DB, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_sqlite_db():
    """Initialize SQLite database schema"""
    import sqlite3
    conn = get_sqlite_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_name TEXT NOT NULL,
        first_name TEXT,
        middle_initial TEXT,
        last_name TEXT,
        suffix TEXT,
        id_nickname TEXT,
        id_number TEXT NOT NULL,
        position TEXT NOT NULL,
        location_branch TEXT,
        department TEXT,
        email TEXT,
        personal_number TEXT,
        photo_path TEXT NOT NULL,
        photo_url TEXT,
        new_photo INTEGER DEFAULT 1,
        new_photo_url TEXT,
        nobg_photo_url TEXT,
        signature_path TEXT,
        signature_url TEXT,
        status TEXT DEFAULT 'Reviewing',
        date_last_modified TEXT,
        id_generated INTEGER DEFAULT 0,
        render_url TEXT,
        emergency_name TEXT,
        emergency_contact TEXT,
        emergency_address TEXT,
        field_officer_type TEXT,
        field_clearance TEXT,
        fo_division TEXT,
        fo_department TEXT,
        fo_campaign TEXT,
        resolved_printer_branch TEXT
    )
    """)
    
    # Create security events table for logging screenshot/recording attempts
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        details TEXT,
        user_id INTEGER,
        username TEXT,
        url TEXT,
        user_agent TEXT,
        screen_resolution TEXT,
        timestamp_server TEXT NOT NULL,
        timestamp_client TEXT,
        created_at TEXT NOT NULL
    )
    """)
    
    # Migration for existing SQLite databases
    migrations = [
        "ALTER TABLE employees ADD COLUMN new_photo_url TEXT",
        "ALTER TABLE employees ADD COLUMN nobg_photo_url TEXT",
        "ALTER TABLE employees ADD COLUMN emergency_name TEXT",
        "ALTER TABLE employees ADD COLUMN emergency_contact TEXT",
        "ALTER TABLE employees ADD COLUMN emergency_address TEXT",
        "ALTER TABLE employees ADD COLUMN first_name TEXT",
        "ALTER TABLE employees ADD COLUMN middle_initial TEXT",
        "ALTER TABLE employees ADD COLUMN last_name TEXT",
        "ALTER TABLE employees ADD COLUMN suffix TEXT",
        "ALTER TABLE employees ADD COLUMN location_branch TEXT",
        "ALTER TABLE employees ADD COLUMN field_officer_type TEXT",
        "ALTER TABLE employees ADD COLUMN field_clearance TEXT",
        "ALTER TABLE employees ADD COLUMN fo_division TEXT",
        "ALTER TABLE employees ADD COLUMN fo_department TEXT",
        "ALTER TABLE employees ADD COLUMN fo_campaign TEXT",
        "ALTER TABLE employees ADD COLUMN resolved_printer_branch TEXT"
    ]
    for sql in migrations:
        try:
            cursor.execute(sql)
            conn.commit()
        except:
            pass  # Column already exists
    
    conn.commit()
    conn.close()


# =============================================================================
# Supabase Database Operations
# =============================================================================
def init_db():
    """Initialize database - creates table if using SQLite or verifies Supabase"""
    if USE_SUPABASE:
        # Supabase table should be created via SQL Editor in dashboard
        try:
            result = supabase_client.table("employees").select("id").limit(1).execute()
            logger.info("Supabase employees table verified")
        except Exception as e:
            logger.error(f"Supabase table check failed: {e}")
            logger.info("Please create the 'employees' table in Supabase Dashboard")
    else:
        init_sqlite_db()
        logger.info("SQLite database initialized")


def get_connection():
    """Get database connection - returns SQLite connection or None for Supabase"""
    if USE_SUPABASE:
        return None  # Supabase uses client directly
    return get_sqlite_connection()


# =============================================================================
# Employee CRUD Operations
# =============================================================================
def insert_employee(data: Dict[str, Any]) -> Optional[int]:
    """Insert a new employee record with logging and defensive fallback"""
    # Defensive fallback: Ensure field_officer_type exists (insert as NULL/empty if missing)
    field_officer_fields = ['field_officer_type', 'field_clearance', 'fo_division', 'fo_department', 'fo_campaign']
    for field in field_officer_fields:
        if field not in data or data[field] is None:
            data[field] = ''  # Set to empty string instead of NULL to prevent errors
    
    # Log the payload before insertion
    logger.info("=" * 60)
    logger.info("📝 INSERT_EMPLOYEE - Final Payload:")
    logger.info(f"  Database: {'Supabase' if USE_SUPABASE else 'SQLite'}")
    logger.info(f"  Columns: {list(data.keys())}")
    logger.info(f"  field_officer_type: {data.get('field_officer_type', 'NOT SET')}")
    logger.info("=" * 60)
    
    if USE_SUPABASE:
        try:
            # Remove id if present (auto-generated)
            insert_data = {k: v for k, v in data.items() if k != 'id'}
            # Convert boolean fields
            if 'new_photo' in insert_data:
                insert_data['new_photo'] = bool(insert_data['new_photo'])
            if 'id_generated' in insert_data:
                insert_data['id_generated'] = bool(insert_data['id_generated'])
            
            logger.info(f"Supabase INSERT columns: {list(insert_data.keys())}")
            result = supabase_client.table("employees").insert(insert_data).execute()
            if result.data:
                logger.info(f"✅ Supabase INSERT successful, id={result.data[0].get('id')}")
                return result.data[0].get('id')
            return None
        except Exception as e:
            logger.error(f"❌ Supabase insert error: {e}")
            return None
    else:
        # SQLite fallback
        import sqlite3
        conn = get_sqlite_connection()
        cursor = conn.cursor()
        
        columns = ', '.join(data.keys())
        placeholders = ', '.join(['?' for _ in data])
        values = tuple(data.values())
        
        sql = f"INSERT INTO employees ({columns}) VALUES ({placeholders})"
        logger.info(f"SQLite INSERT SQL: {sql}")
        logger.info(f"SQLite INSERT values count: {len(values)}")
        
        try:
            cursor.execute(sql, values)
            employee_id = cursor.lastrowid
            conn.commit()
            conn.close()
            logger.info(f"✅ SQLite INSERT successful, id={employee_id}")
            return employee_id
        except Exception as e:
            logger.error(f"❌ SQLite insert error: {e}")
            conn.close()
            return None


def get_all_employees(include_removed: bool = False) -> List[Dict[str, Any]]:
    """Get all employees ordered by date.
    
    Args:
        include_removed: If False (default), excludes employees with status 'Removed'.
                         Set to True only for audit/history purposes.
    """
    if USE_SUPABASE:
        try:
            query = supabase_client.table("employees").select("*")
            if not include_removed:
                query = query.neq("status", "Removed")
            result = query.order("date_last_modified", desc=True).execute()
            return result.data or []
        except Exception as e:
            logger.error(f"Supabase fetch error: {e}")
            return []
    else:
        # SQLite fallback
        conn = get_sqlite_connection()
        cursor = conn.cursor()
        if not include_removed:
            cursor.execute("SELECT * FROM employees WHERE status != 'Removed' ORDER BY date_last_modified DESC")
        else:
            cursor.execute("SELECT * FROM employees ORDER BY date_last_modified DESC")
        rows = cursor.fetchall()
        conn.close()
        return [dict(row) for row in rows]


def get_employee_by_id(employee_id: int) -> Optional[Dict[str, Any]]:
    """Get a single employee by ID"""
    if USE_SUPABASE:
        try:
            result = supabase_client.table("employees").select("*").eq("id", employee_id).single().execute()
            return result.data
        except Exception as e:
            logger.error(f"Supabase fetch by ID error: {e}")
            return None
    else:
        # SQLite fallback
        conn = get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM employees WHERE id = ?", (employee_id,))
        row = cursor.fetchone()
        conn.close()
        return dict(row) if row else None


def get_employee_by_id_number(id_number: str) -> Optional[Dict[str, Any]]:
    """Get a single employee by ID number (for uniqueness check).
    Excludes Removed employees so their ID numbers can be re-registered."""
    if not id_number:
        return None
        
    if USE_SUPABASE:
        try:
            result = supabase_client.table("employees").select("*").eq("id_number", id_number).neq("status", "Removed").execute()
            if result.data and len(result.data) > 0:
                return result.data[0]
            return None
        except Exception as e:
            logger.error(f"Supabase fetch by id_number error: {e}")
            return None
    else:
        # SQLite fallback
        conn = get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM employees WHERE id_number = ? AND status != 'Removed'", (id_number,))
        row = cursor.fetchone()
        conn.close()
        return dict(row) if row else None


def update_employee(employee_id: int, data: Dict[str, Any]) -> bool:
    """Update an employee record"""
    if USE_SUPABASE:
        try:
            # Convert boolean fields
            update_data = data.copy()
            if 'new_photo' in update_data:
                update_data['new_photo'] = bool(update_data['new_photo'])
            if 'id_generated' in update_data:
                update_data['id_generated'] = bool(update_data['id_generated'])
            
            result = supabase_client.table("employees").update(update_data).eq("id", employee_id).execute()
            return len(result.data) > 0
        except Exception as e:
            logger.error(f"Supabase update error: {e}")
            return False
    else:
        # SQLite fallback
        conn = get_sqlite_connection()
        cursor = conn.cursor()
        
        set_clause = ', '.join([f"{k} = ?" for k in data.keys()])
        values = tuple(data.values()) + (employee_id,)
        
        cursor.execute(f"UPDATE employees SET {set_clause} WHERE id = ?", values)
        conn.commit()
        affected = cursor.rowcount
        conn.close()
        return affected > 0


def update_employee_status_rpc(employee_id: int, status: str) -> bool:
    """Update employee status using RPC to bypass PostgREST schema cache issues."""
    if USE_SUPABASE:
        try:
            result = supabase_client.rpc("update_employee_status", {
                "p_employee_id": employee_id,
                "p_status": status,
                "p_date_modified": datetime.now().isoformat()
            }).execute()
            return result.data is True
        except Exception as e:
            logger.error(f"Supabase RPC update_employee_status error: {e}")
            # Fallback to regular update
            return update_employee(employee_id, {
                "status": status,
                "date_last_modified": datetime.now().isoformat()
            })
    else:
        return update_employee(employee_id, {
            "status": status,
            "date_last_modified": datetime.now().isoformat()
        })


def delete_employee(employee_id: int) -> bool:
    """Delete an employee record"""
    if USE_SUPABASE:
        try:
            result = supabase_client.table("employees").delete().eq("id", employee_id).execute()
            return len(result.data) > 0
        except Exception as e:
            logger.error(f"Supabase delete error: {e}")
            return False
    else:
        # SQLite fallback
        conn = get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM employees WHERE id = ?", (employee_id,))
        conn.commit()
        affected = cursor.rowcount
        conn.close()
        return affected > 0


def table_exists() -> bool:
    """Check if employees table exists"""
    if USE_SUPABASE:
        try:
            supabase_client.table("employees").select("id").limit(1).execute()
            return True
        except:
            return False
    else:
        # SQLite fallback
        conn = get_sqlite_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='employees'")
        result = cursor.fetchone()
        conn.close()
        return result is not None


def get_employee_count(include_removed: bool = False) -> int:
    """Get total employee count, excluding Removed by default"""
    if USE_SUPABASE:
        try:
            query = supabase_client.table("employees").select("id", count="exact")
            if not include_removed:
                query = query.neq("status", "Removed")
            result = query.execute()
            return result.count or 0
        except Exception as e:
            logger.error(f"Supabase count error: {e}")
            return 0
    else:
        # SQLite fallback
        conn = get_sqlite_connection()
        cursor = conn.cursor()
        if not include_removed:
            cursor.execute("SELECT COUNT(*) as count FROM employees WHERE status != 'Removed'")
        else:
            cursor.execute("SELECT COUNT(*) as count FROM employees")
        result = cursor.fetchone()
        conn.close()
        return result[0] if result else 0


def get_status_breakdown(include_removed: bool = False) -> Dict[str, int]:
    """Get employee count by status, excluding Removed by default"""
    if USE_SUPABASE:
        try:
            # Supabase doesn't have GROUP BY in REST API, so we fetch all and count
            query = supabase_client.table("employees").select("status")
            if not include_removed:
                query = query.neq("status", "Removed")
            result = query.execute()
            counts = {}
            for row in result.data or []:
                status = row.get('status') or 'Reviewing'
                counts[status] = counts.get(status, 0) + 1
            return counts
        except Exception as e:
            logger.error(f"Supabase status breakdown error: {e}")
            return {}
    else:
        # SQLite fallback
        conn = get_sqlite_connection()
        cursor = conn.cursor()
        if not include_removed:
            cursor.execute("SELECT status, COUNT(*) as count FROM employees WHERE status != 'Removed' GROUP BY status")
        else:
            cursor.execute("SELECT status, COUNT(*) as count FROM employees GROUP BY status")
        rows = cursor.fetchall()
        conn.close()
        return {row[0] or 'Reviewing': row[1] for row in rows}


# =============================================================================
# Security Event Logging (Screenshot/Recording Detection)
# =============================================================================
def insert_security_event(
    event_type: str,
    details: str = "",
    user_id: Optional[int] = None,
    username: str = "anonymous",
    url: str = "",
    user_agent: str = "",
    screen_resolution: str = "",
    timestamp_client: str = None,
) -> Optional[int]:
    """
    Log a security event (screenshot/recording detection).
    
    Args:
        event_type: Type of event (printscreen_key, ctrl_shift_s, recording_heuristic, etc.)
        details: Additional details about the event
        user_id: User ID if available
        username: Username if available
        url: URL where event occurred
        user_agent: Client user agent string
        screen_resolution: Screen resolution string
        timestamp_client: Client-provided timestamp
    
    Returns:
        Event ID if successful, None otherwise
    """
    if USE_SUPABASE:
        try:
            data = {
                "event_type": event_type,
                "details": details,
                "user_id": user_id,
                "username": username,
                "url": url,
                "user_agent": user_agent,
                "screen_resolution": screen_resolution,
                "timestamp_server": datetime.utcnow().isoformat(),
                "timestamp_client": timestamp_client or datetime.utcnow().isoformat(),
                "created_at": datetime.utcnow().isoformat(),
            }
            result = supabase_client.table("security_events").insert(data).execute()
            if result.data:
                logger.info(f"Security event logged to Supabase: {event_type} by {username}")
                return result.data[0].get('id')
            return None
        except Exception as e:
            logger.error(f"Supabase security event insert error: {e}")
            return None
    else:
        # SQLite fallback
        import sqlite3
        try:
            conn = get_sqlite_connection()
            cursor = conn.cursor()
            
            cursor.execute("""
                INSERT INTO security_events 
                (event_type, details, user_id, username, url, user_agent, screen_resolution, 
                 timestamp_server, timestamp_client, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                event_type, details, user_id, username, url, user_agent, screen_resolution,
                datetime.utcnow().isoformat(), timestamp_client or datetime.utcnow().isoformat(),
                datetime.utcnow().isoformat()
            ))
            
            event_id = cursor.lastrowid
            conn.commit()
            conn.close()
            
            logger.info(f"Security event logged to SQLite: {event_type} by {username}")
            return event_id
        except Exception as e:
            logger.error(f"SQLite security event insert error: {e}")
            return None


def get_security_events(
    limit: int = 100,
    offset: int = 0,
    username: Optional[str] = None,
    event_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Retrieve security events with optional filtering.
    
    Args:
        limit: Maximum number of events to return
        offset: Pagination offset
        username: Filter by username
        event_type: Filter by event type
    
    Returns:
        List of security events
    """
    if USE_SUPABASE:
        try:
            query = supabase_client.table("security_events").select("*")
            
            if username:
                query = query.eq("username", username)
            if event_type:
                query = query.eq("event_type", event_type)
            
            query = query.order("created_at", desc=True).range(offset, offset + limit - 1)
            result = query.execute()
            return result.data or []
        except Exception as e:
            logger.error(f"Supabase security events fetch error: {e}")
            return []
    else:
        # SQLite fallback
        import sqlite3
        try:
            conn = get_sqlite_connection()
            cursor = conn.cursor()
            
            where_clauses = []
            params = []
            
            if username:
                where_clauses.append("username = ?")
                params.append(username)
            if event_type:
                where_clauses.append("event_type = ?")
                params.append(event_type)
            
            where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"
            
            cursor.execute(f"""
                SELECT * FROM security_events 
                WHERE {where_sql}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
            """, params + [limit, offset])
            
            rows = cursor.fetchall()
            conn.close()
            return [dict(row) for row in rows]
        except Exception as e:
            logger.error(f"SQLite security events fetch error: {e}")
            return []


def get_security_statistics() -> Dict[str, Any]:
    """
    Get aggregated security statistics.
    
    Returns:
        Dictionary with statistics about security events
    """
    if USE_SUPABASE:
        try:
            result = supabase_client.table("security_events").select("event_type").execute()
            events = result.data or []
            
            event_counts = {}
            user_counts = {}
            
            for event in events:
                event_type = event.get('event_type', 'unknown')
                event_counts[event_type] = event_counts.get(event_type, 0) + 1
                # Note: Supabase REST doesn't include username in simple select
            
            return {
                "total_events": len(events),
                "event_types": event_counts,
                "unique_users": len(user_counts),
            }
        except Exception as e:
            logger.error(f"Supabase statistics error: {e}")
            return {}
    else:
        # SQLite fallback
        import sqlite3
        try:
            conn = get_sqlite_connection()
            cursor = conn.cursor()
            
            # Total events
            cursor.execute("SELECT COUNT(*) FROM security_events")
            total = cursor.fetchone()[0]
            
            # Event type breakdown
            cursor.execute("SELECT event_type, COUNT(*) as count FROM security_events GROUP BY event_type")
            event_types = {row[0]: row[1] for row in cursor.fetchall()}
            
            # Unique users
            cursor.execute("SELECT COUNT(DISTINCT username) FROM security_events")
            unique_users = cursor.fetchone()[0]
            
            # Recent events (last 24 hours)
            cursor.execute("""
                SELECT COUNT(*) FROM security_events 
                WHERE datetime(created_at) > datetime('now', '-1 day')
            """)
            recent_24h = cursor.fetchone()[0]
            
            conn.close()
            
            return {
                "total_events": total,
                "event_types": event_types,
                "unique_users": unique_users,
                "recent_24h": recent_24h,
            }
        except Exception as e:
            logger.error(f"SQLite statistics error: {e}")
            return {}


# =============================================================================
# AI Headshot Rate Limiting
# =============================================================================
HEADSHOT_LIMIT_PER_USER = 5

# Track whether the is_reset column exists in Supabase (checked once)
_supabase_has_is_reset = None


def _check_supabase_is_reset_column():
    """Check if is_reset column exists in headshot_usage table. Cached after first call."""
    global _supabase_has_is_reset
    if _supabase_has_is_reset is not None:
        return _supabase_has_is_reset
    if not USE_SUPABASE:
        _supabase_has_is_reset = True  # SQLite always has it via _init
        return True
    try:
        supabase_client.table("headshot_usage").select("is_reset").limit(1).execute()
        _supabase_has_is_reset = True
        logger.info("Supabase headshot_usage: is_reset column exists")
    except Exception:
        _supabase_has_is_reset = False
        logger.warning("Supabase headshot_usage: is_reset column NOT found. "
                       "Run: ALTER TABLE headshot_usage ADD COLUMN IF NOT EXISTS is_reset BOOLEAN DEFAULT FALSE;")
    return _supabase_has_is_reset


def _init_headshot_usage_sqlite():
    """Create headshot_usage table in SQLite if it doesn't exist."""
    import sqlite3
    conn = get_sqlite_connection()
    cursor = conn.cursor()
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS headshot_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lark_user_id TEXT NOT NULL,
        lark_name TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        is_reset INTEGER NOT NULL DEFAULT 0
    )
    """)
    # Add lark_name column if table already exists without it
    try:
        cursor.execute("ALTER TABLE headshot_usage ADD COLUMN lark_name TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass  # Column already exists
    # Add is_reset column if table already exists without it
    try:
        cursor.execute("ALTER TABLE headshot_usage ADD COLUMN is_reset INTEGER NOT NULL DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # Column already exists
    cursor.execute("""
    CREATE INDEX IF NOT EXISTS idx_headshot_usage_lark_user
    ON headshot_usage(lark_user_id)
    """)
    conn.commit()
    conn.close()


def get_headshot_usage_count(lark_user_id: str) -> int:
    """Get the number of active (non-reset) AI headshot generations for a Lark user."""
    if not lark_user_id:
        return 0

    if USE_SUPABASE:
        has_is_reset = _check_supabase_is_reset_column()
        try:
            query = (
                supabase_client.table("headshot_usage")
                .select("id", count="exact")
                .eq("lark_user_id", lark_user_id)
            )
            if has_is_reset:
                query = query.eq("is_reset", False)
            result = query.execute()
            return result.count if result.count is not None else 0
        except Exception as e:
            logger.error(f"Supabase headshot usage count error: {e}")
            return 0
    else:
        import sqlite3
        try:
            _init_headshot_usage_sqlite()
            conn = get_sqlite_connection()
            cursor = conn.cursor()
            cursor.execute(
                "SELECT COUNT(*) FROM headshot_usage WHERE lark_user_id = ? AND is_reset = 0",
                (lark_user_id,),
            )
            count = cursor.fetchone()[0]
            conn.close()
            return count
        except Exception as e:
            logger.error(f"SQLite headshot usage count error: {e}")
            return 0


def increment_headshot_usage(lark_user_id: str, lark_name: str = "") -> bool:
    """Record a new AI headshot generation for a Lark user. Returns True on success."""
    if not lark_user_id:
        return False

    if USE_SUPABASE:
        try:
            supabase_client.table("headshot_usage").insert(
                {"lark_user_id": lark_user_id, "lark_name": lark_name or ""}
            ).execute()
            return True
        except Exception as e:
            logger.error(f"Supabase headshot usage insert error: {e}")
            return False
    else:
        import sqlite3
        try:
            _init_headshot_usage_sqlite()
            conn = get_sqlite_connection()
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO headshot_usage (lark_user_id, lark_name, created_at) VALUES (?, ?, datetime('now'))",
                (lark_user_id, lark_name or ""),
            )
            conn.commit()
            conn.close()
            return True
        except Exception as e:
            logger.error(f"SQLite headshot usage insert error: {e}")
            return False


def check_headshot_limit(lark_user_id: str) -> dict:
    """
    Check if a Lark user can generate another AI headshot.
    Returns dict with 'allowed' (bool), 'used' (int), 'limit' (int), 'remaining' (int).
    """
    used = get_headshot_usage_count(lark_user_id)
    remaining = max(0, HEADSHOT_LIMIT_PER_USER - used)
    return {
        "allowed": remaining > 0,
        "used": used,
        "limit": HEADSHOT_LIMIT_PER_USER,
        "remaining": remaining,
    }


def get_all_headshot_usage() -> list:
    """
    Get aggregated headshot usage for all Lark users.
    Returns list of dicts with current cycle (non-reset) and total historical counts.
    """
    if USE_SUPABASE:
        has_is_reset = _check_supabase_is_reset_column()
        try:
            select_cols = "lark_user_id, lark_name, created_at, is_reset" if has_is_reset else "lark_user_id, lark_name, created_at"
            result = (
                supabase_client.table("headshot_usage")
                .select(select_cols)
                .order("created_at", desc=True)
                .execute()
            )
            # Aggregate in Python
            from collections import defaultdict
            usage_map = defaultdict(lambda: {"active_count": 0, "total_count": 0, "last_used": None, "lark_name": ""})
            for row in (result.data or []):
                uid = row["lark_user_id"]
                usage_map[uid]["total_count"] += 1
                is_reset = row.get("is_reset", False) if has_is_reset else False
                if not is_reset:
                    usage_map[uid]["active_count"] += 1
                ts = row["created_at"]
                if usage_map[uid]["last_used"] is None or ts > usage_map[uid]["last_used"]:
                    usage_map[uid]["last_used"] = ts
                # Keep the most recent non-empty name
                name = row.get("lark_name") or ""
                if name and not usage_map[uid]["lark_name"]:
                    usage_map[uid]["lark_name"] = name

            return [
                {
                    "lark_user_id": uid,
                    "lark_name": info["lark_name"],
                    "usage_count": info["active_count"],
                    "total_generations": info["total_count"],
                    "last_used": info["last_used"],
                    "limit": HEADSHOT_LIMIT_PER_USER,
                    "remaining": max(0, HEADSHOT_LIMIT_PER_USER - info["active_count"]),
                }
                for uid, info in usage_map.items()
            ]
        except Exception as e:
            logger.error(f"Supabase get_all_headshot_usage error: {e}")
            return []
    else:
        import sqlite3
        try:
            _init_headshot_usage_sqlite()
            conn = get_sqlite_connection()
            cursor = conn.cursor()
            cursor.execute("""
                SELECT lark_user_id,
                       SUM(CASE WHEN is_reset = 0 THEN 1 ELSE 0 END) as active_count,
                       COUNT(*) as total_count,
                       MAX(created_at) as last_used,
                       MAX(lark_name) as lark_name
                FROM headshot_usage
                GROUP BY lark_user_id
                ORDER BY last_used DESC
            """)
            rows = cursor.fetchall()
            conn.close()
            return [
                {
                    "lark_user_id": row[0],
                    "lark_name": row[4] or "",
                    "usage_count": row[1],
                    "total_generations": row[2],
                    "last_used": row[3],
                    "limit": HEADSHOT_LIMIT_PER_USER,
                    "remaining": max(0, HEADSHOT_LIMIT_PER_USER - row[1]),
                }
                for row in rows
            ]
        except Exception as e:
            logger.error(f"SQLite get_all_headshot_usage error: {e}")
            return []


def reset_headshot_usage(lark_user_id: str) -> bool:
    """Mark all active headshot usage records as reset for a Lark user (preserves history)."""
    if not lark_user_id:
        return False

    if USE_SUPABASE:
        has_is_reset = _check_supabase_is_reset_column()
        try:
            if has_is_reset:
                supabase_client.table("headshot_usage").update(
                    {"is_reset": True}
                ).eq("lark_user_id", lark_user_id).eq("is_reset", False).execute()
                logger.info(f"Reset headshot usage for lark_user_id={lark_user_id} (history preserved)")
            else:
                supabase_client.table("headshot_usage").delete().eq(
                    "lark_user_id", lark_user_id
                ).execute()
                logger.info(f"Reset headshot usage for lark_user_id={lark_user_id} (deleted, no is_reset column)")
            return True
        except Exception as e:
            logger.error(f"Supabase reset_headshot_usage error: {e}")
            return False
    else:
        import sqlite3
        try:
            _init_headshot_usage_sqlite()
            conn = get_sqlite_connection()
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE headshot_usage SET is_reset = 1 WHERE lark_user_id = ? AND is_reset = 0",
                (lark_user_id,),
            )
            conn.commit()
            conn.close()
            logger.info(f"Reset headshot usage for lark_user_id={lark_user_id} (SQLite, history preserved)")
            return True
        except Exception as e:
            logger.error(f"SQLite reset_headshot_usage error: {e}")
            return False


def reset_all_headshot_usage() -> int:
    """Mark ALL active headshot usage records as reset (preserves history). Returns count reset."""
    if USE_SUPABASE:
        has_is_reset = _check_supabase_is_reset_column()
        try:
            if has_is_reset:
                # Count active records first
                count_result = (
                    supabase_client.table("headshot_usage")
                    .select("id", count="exact")
                    .eq("is_reset", False)
                    .execute()
                )
                count = count_result.count if count_result.count is not None else 0
                # Mark all active records as reset
                if count > 0:
                    supabase_client.table("headshot_usage").update(
                        {"is_reset": True}
                    ).eq("is_reset", False).execute()
                logger.info(f"Reset ALL headshot usage: {count} records marked as reset (Supabase)")
            else:
                result = (
                    supabase_client.table("headshot_usage")
                    .delete()
                    .neq("lark_user_id", "___IMPOSSIBLE_VALUE___")
                    .execute()
                )
                count = len(result.data) if result.data else 0
                logger.info(f"Reset ALL headshot usage: {count} records deleted (Supabase, no is_reset column)")
            return count
        except Exception as e:
            logger.error(f"Supabase reset_all_headshot_usage error: {e}")
            return -1
    else:
        import sqlite3
        try:
            _init_headshot_usage_sqlite()
            conn = get_sqlite_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM headshot_usage WHERE is_reset = 0")
            count = cursor.fetchone()[0]
            cursor.execute("UPDATE headshot_usage SET is_reset = 1 WHERE is_reset = 0")
            conn.commit()
            conn.close()
            logger.info(f"Reset ALL headshot usage: {count} records marked as reset (SQLite)")
            return count
        except Exception as e:
            logger.error(f"SQLite reset_all_headshot_usage error: {e}")
            return -1
