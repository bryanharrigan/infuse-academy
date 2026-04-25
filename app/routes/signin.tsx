import { Alert, Button, TextField } from "@mui/material";
import type { ActionFunctionArgs } from "@remix-run/node";
import { Form, json, redirect, useActionData } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { AbsorbLogo } from "~/components/logo/logo.component";
import { infuseJwtCookie } from "~/constants/infuse-cookie.server";
import { authenticate } from "~/.server/infuse-api";

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const username = formData.get("username") as string;
  const password = formData.get("password") as string;
  try {
    const { token } = await authenticate(username, password);
    const cookieHeader = await infuseJwtCookie.serialize(token);
    return redirect("/", { headers: { "Set-Cookie": cookieHeader } });
  } catch (err) {
    // TEMPORARY DIAGNOSTIC: surface the underlying error message so we can
    // see exactly what Absorb returned (status code) and confirm the Lambda
    // hit the right URL. Revert to the generic message once auth is working.
    const detail = err instanceof Error ? err.message : String(err);
    return json({ error: `Auth failed — ${detail}` }, { status: 401 });
  }
};

export default function SignIn() {
  const actionData = useActionData<typeof action>();
  const formRef = useRef<HTMLFormElement>(null);
  const userNameRef = useRef<HTMLInputElement>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (actionData && actionData.error) {
      setSubmitted(false);
      formRef.current?.reset();
      userNameRef.current?.focus();
    }
  }, [actionData]);

  return (
    <div className="flex items-center justify-center h-screen bg-gray-200">
      <div className="flex flex-col items-center bg-white w-[400px] rounded-lg px-6 py-12 shadow-lg">
        <AbsorbLogo className="mb-4" />
        <div className="text-lg mb-4">Sign in to Absorb Infuse</div>
        <Form method="post" ref={formRef} className="w-full" onSubmit={() => setSubmitted(true)}>
          {actionData && actionData.error && (
            <Alert variant="filled" severity="error" className="mb-4">
              {actionData.error}
            </Alert>
          )}
          <div className="mb-4">
            <TextField inputRef={userNameRef} name="username" label="User name" variant="outlined" fullWidth disabled={submitted} />
          </div>
          <div className="mb-4">
            <TextField name="password" label="Password" variant="outlined" type="password" fullWidth disabled={submitted} />
          </div>
          <div>
            <Button type="submit" variant="contained" disabled={submitted}>Submit</Button>
          </div>
        </Form>
      </div>
    </div>
  );
}
