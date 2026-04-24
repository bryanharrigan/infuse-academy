import { useLoaderData } from "@remix-run/react";
import Cookies from "js-cookie";
import { loader } from "~/root";

type UseCurrentUser = {
  isLoggedIn: boolean;
  firstName: string | undefined;
  lastName: string | undefined;
  avatarUrl: string | undefined;
};

export const useCurrentUser = (): UseCurrentUser => {
  const data = useLoaderData<typeof loader>();

  return {
    isLoggedIn: !!Cookies.get("infuse_jwt"),
    firstName: data?.userProfile.firstName,
    lastName: data?.userProfile.lastName,
    avatarUrl: data?.avatarUrl,
  };
};
