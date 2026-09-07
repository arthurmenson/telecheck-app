-- Removes discovery only; previously accepted payments and clinical records stay.
DROP FUNCTION public.billing_patient_consult_payments(INTEGER);
