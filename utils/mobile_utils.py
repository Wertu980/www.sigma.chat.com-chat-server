import phonenumbers
from fastapi import HTTPException
from core.config import settings

def normalize_mobile(msisdn: str) -> str:
    """
    Normalize and validate a mobile number globally (E.164 format).

    Examples:
      "+14155552671"   -> "+14155552671"   (US)
      "00441234567890" -> "+441234567890"  (UK)
      "9876543210"     -> "+919876543210"  (uses default country if missing)
    """

    msisdn = msisdn.strip()

    # Try to parse the number globally; use default country if none provided
    try:
        # default region if number lacks '+'
        region = settings.DEFAULT_COUNTRY.upper() if hasattr(settings, "DEFAULT_COUNTRY") else "IN"
        parsed = phonenumbers.parse(msisdn, region)
    except phonenumbers.NumberParseException:
        raise HTTPException(status_code=400, detail="Invalid phone number format")

    # Validate actual phone number
    if not phonenumbers.is_valid_number(parsed):
        raise HTTPException(status_code=400, detail="Invalid or unsupported mobile number")

    # Return standardized E.164 format (+<countrycode><number>)
    return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)