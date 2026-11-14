
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/auth';
import { toast } from 'sonner';

const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const WARNING_BEFORE_TIMEOUT = 30 * 60 * 1000; // 30 minutes before timeout
const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart'];
const INACTIVITY_THRESHOLD = 60 * 60 * 1000; // 1 hour of inactivity

export const useSessionTimeout = () => {
  const { user, logout, login, refreshUserData } = useAuth();
  const [lastActivity, setLastActivity] = useState<number>(Date.now());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warningRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inactivityRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Function to update the last activity timestamp
  const updateActivity = () => {
    setLastActivity(Date.now());
    // Store last activity in localStorage for persistence across page reloads
    localStorage.setItem('avante_last_activity', Date.now().toString());
  };

  // Set up activity monitoring
  useEffect(() => {
    // Check if there's a stored last activity timestamp
    const storedLastActivity = localStorage.getItem('avante_last_activity');
    if (storedLastActivity) {
      setLastActivity(parseInt(storedLastActivity, 10));
    }

    // Add event listeners for user activity
    ACTIVITY_EVENTS.forEach(event => {
      window.addEventListener(event, updateActivity);
    });

    // Cleanup
    return () => {
      ACTIVITY_EVENTS.forEach(event => {
        window.removeEventListener(event, updateActivity);
      });
    };
  }, []);

  // Handle session timeout and inactivity checks
  useEffect(() => {
    // Only set up timeouts if the user is logged in
    if (user) {
      const timeUntilExpiry = (user.lastAuthenticated + SESSION_TIMEOUT) - Date.now();
      const timeUntilWarning = timeUntilExpiry - WARNING_BEFORE_TIMEOUT;
      
      // Clear any existing timeouts
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (warningRef.current) clearTimeout(warningRef.current);
      if (inactivityRef.current) clearTimeout(inactivityRef.current);

      // Set a warning before the session expires
      if (timeUntilWarning > 0) {
        warningRef.current = setTimeout(() => {
          toast.warning("Your session will expire soon.", {
            action: {
              label: "Stay logged in",
              onClick: () => {
                refreshUserData();
                toast.success("Session extended");
                // Update the authentication timestamp in localStorage
                localStorage.setItem('avante_last_authenticated', Date.now().toString());
              }
            },
            duration: 10000,
          });
        }, timeUntilWarning);
      }

      // Set a timeout to log the user out when the session expires
      if (timeUntilExpiry > 0) {
        timeoutRef.current = setTimeout(() => {
          toast.error("Your session has expired. Please log in again.");
          logout({ automatic: true });
        }, timeUntilExpiry);
      } else {
        // Session has already expired
        logout({ automatic: true });
      }

      // Check for inactivity
      inactivityRef.current = setInterval(() => {
        const inactiveTime = Date.now() - lastActivity;
        
        // If user has been inactive for too long, refresh token silently
        if (inactiveTime > INACTIVITY_THRESHOLD) {
          console.log("Detected inactivity, refreshing session silently");
          refreshUserData();
          setLastActivity(Date.now()); // Reset inactivity timer
          localStorage.setItem('avante_last_activity', Date.now().toString());
        }
      }, 60000); // Check every minute
    }

    // Cleanup function
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (warningRef.current) clearTimeout(warningRef.current);
      if (inactivityRef.current) clearInterval(inactivityRef.current);
    };
  }, [user, logout, login, refreshUserData, lastActivity]);

  return null; // This hook doesn't return anything
};
