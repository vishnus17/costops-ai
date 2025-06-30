export async function handler(event) {
    const email = event.request.userAttributes.email || '';
    if (email.endsWith('@amazon.com')) {
        return event;
    } else {
        throw new Error('Signup allowed only for AWS folks until further notice.');
    }
}