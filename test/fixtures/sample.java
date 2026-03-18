package com.example;

/**
 * Represents a user account.
 */
interface Authenticatable {
    boolean authenticate(String password);
    void resetPassword();
}

enum Role {
    ADMIN,
    USER,
    GUEST
}

class UserAccount implements Authenticatable {
    private String username;
    private String passwordHash;
    private Role role;

    public UserAccount(String username, String passwordHash, Role role) {
        this.username = username;
        this.passwordHash = passwordHash;
        this.role = role;
    }

    public boolean authenticate(String password) {
        return this.passwordHash.equals(hashPassword(password));
    }

    public void resetPassword() {
        this.passwordHash = "";
    }

    private String hashPassword(String password) {
        return Integer.toHexString(password.hashCode());
    }
}
